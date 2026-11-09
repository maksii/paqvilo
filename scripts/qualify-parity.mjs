// Strict, manifest-driven qualification of existing tests. Semantic evidence review
// belongs to the manifest author; this tool checks bindings and never invents proof.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinModules, createRequire } from 'node:module';
import { parseTestKinds, kindsAt } from './check-test-tags.mjs';
import { validateMicrosoftCdnArtifact } from './parity-official-artifacts.mjs';
import { analyzeGeneratedFixtures, analyzeUnselectedFixtureSlice } from './parity-generated-fixtures.mjs';
import { analyzeMemoryRendererSlice } from './parity-memory-renderer-slice.mjs';
import { certifyMemoryContextSlice } from './parity-memory-context-slice.mjs';
import { verifyCaseMigration } from './parity-case-migration.mjs';
import { analyzePowerFxHostSlice } from './parity-powerfx-host-slice.mjs';
import { analyzeRoutingInputSlice } from './parity-loopback-fixture-slice.mjs';
import { reviewApiRouterSlice } from './parity-api-router-slice.mjs';
import { analyzeMixedPlainRendererSlice } from './parity-mixed-plain-renderer-slice.mjs';
import { analyzeRecordsFixtureSlice } from './parity-records-fixture-slice.mjs';
import { verifyScalarMigration } from './parity-scalar-migration.mjs';
import { analyzeAssertionLoop } from './parity-assertion-loop.mjs';
import { queryUniverse } from './parity-query-universe.mjs';
import { verifyQueryMessageBridge, verifyQueryMessageBridgeCase } from './parity-query-message-bridge.mjs';
import { resolveGitExecutable } from './trusted-git.mjs';

const require = createRequire(import.meta.url);
const { parse } = require('espree');
const { analyze: analyzeScopes } = require('eslint-scope');
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;
const TOOL = fileURLToPath(import.meta.url);
const CONTEXT_VALIDATED = Symbol('context-bindings-validated');
const verifiedContextSources = new Set();
const modelSourcePaths = new WeakMap();
const IMPORT = '__paqParityBindings';
const SOURCE_IMPORT = '__paqParitySourceBindings';
const REGION_IMPORT = '__paqParityAssertions';
const CASE_IMPORT = '__paqParityCaseBindings';
const RECORDS_IMPORT = '__paqRecordsFixtureLiterals';
const SCALAR_IMPORT = '__paqScalarBindings';
const SOAP_IMPORT = '__paqSoapBindings';
const QUERY_IMPORT = '__paqQueryBindings';
export const parityHash = (value) => createHash('sha256').update(value).digest('hex');
export function normalizeParityAst(value) {
  if (typeof value === 'bigint') return { $bigint: String(value) };
  if (Array.isArray(value)) return value.map(normalizeParityAst);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['loc', 'range', 'start', 'end', 'raw'].includes(key))
      .map(([key, item]) => [key, normalizeParityAst(item)]),
  );
}
export const parityAstHash = (node) => parityHash(JSON.stringify(normalizeParityAst(node)));
const fail = (code) => {
  throw Object.assign(new Error(code), { qualificationCode: code });
};
const check = (condition, code) => {
  if (!condition) fail(code);
};
const jsonHash = (value) => parityHash(JSON.stringify(value));
// Match Array's default UTF-16 ordering: descriptor and proof hashes depend on it.
function compareCodeUnits(left, right) {
  const a = String(left),
    b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function confined(root, relative) {
  check(typeof relative === 'string' && relative && !path.isAbsolute(relative), 'non-relative-path');
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  check(rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel), 'path-outside-root');
  if (fs.existsSync(absolute)) {
    const realRoot = fs.realpathSync(root),
      real = fs.realpathSync(absolute);
    const realRel = path.relative(realRoot, real);
    check(
      realRel && realRel !== '..' && !realRel.startsWith('..' + path.sep) && !path.isAbsolute(realRel),
      'symlink-outside-root',
    );
  }
  return absolute;
}
function pointer(value, selector) {
  check(typeof selector === 'string' && (selector === '' || selector.startsWith('/')), 'invalid-json-pointer');
  for (const part of selector === '' ? [] : selector.slice(1).split('/')) {
    check(!/~(?![01])/u.test(part), 'invalid-json-pointer');
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    check(value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'missing-proof-fact');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && Object.hasOwn(descriptor, 'value'), 'proof-accessor');
    value = descriptor.value;
  }
  return value;
}
function childNodes(node) {
  return Object.entries(node)
    .filter(([key]) => !['loc', 'range'].includes(key))
    .flatMap(([, value]) => {
      if (Array.isArray(value)) return value.filter((child) => child?.type);
      return value?.type ? [value] : [];
    });
}
function noUnreviewedExternal(node) {
  check(
    !(
      node.type === 'Identifier' &&
      [
        'globalThis',
        'global',
        'window',
        'self',
        'process',
        'fetch',
        'crypto',
        'Date',
        'performance',
        'navigator',
        'require',
        'eval',
      ].includes(node.name)
    ) &&
      node.type !== 'ImportExpression' &&
      !(
        node.type === 'MemberExpression' &&
        node.object?.name === 'Math' &&
        (node.computed ? node.property.value : node.property.name) === 'random'
      ),
    'added-test-runtime-input-unsupported',
  );
  childNodes(node).forEach(noUnreviewedExternal);
}
function rejectRecordsScheduling(node, parent = null) {
  if (node.type === 'Identifier' && ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'].includes(node.name))
    fail('unsupported-records-async-scheduling');
  if (
    node.type === 'MemberExpression' &&
    node.object?.name === 'process' &&
    !node.computed &&
    node.property.name === 'nextTick'
  )
    fail('unsupported-records-async-scheduling');
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object?.name === 't' &&
    node.callee.property.name === 'test'
  )
    check(
      parent?.type === 'AwaitExpression' &&
        node.arguments.length === 2 &&
        ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.arguments[1]?.type),
      'unsupported-records-async-scheduling',
    );
  childNodes(node).forEach((child) => rejectRecordsScheduling(child, node));
}

function collectLibraryImports(imports) {
  const libraryBindings = new Map();
  for (const node of imports)
    for (const item of node.specifiers)
      libraryBindings.set(item.local.name, {
        source: node.source.value,
        name: item.imported?.name ?? (item.type === 'ImportDefaultSpecifier' ? 'default' : '*'),
      });
  return libraryBindings;
}
function collectTestImports(imports) {
  const bindings = new Map(),
    namespaces = new Set();
  for (const node of imports.filter((item) => item.source.value === 'node:test'))
    for (const item of node.specifiers) {
      if (item.type === 'ImportNamespaceSpecifier') namespaces.add(item.local.name);
      else bindings.set(item.local.name, item.type === 'ImportDefaultSpecifier' ? 'test' : item.imported.name);
    }
  return { bindings, namespaces };
}
function collectAssertionImports(imports) {
  const assertionObjects = new Set(),
    assertionFunctions = new Map();
  for (const node of imports.filter((item) => ['node:assert', 'node:assert/strict'].includes(item.source.value)))
    for (const item of node.specifiers) {
      if (['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(item.type))
        assertionObjects.add(item.local.name);
      else assertionFunctions.set(item.local.name, item.imported.name);
    }
  return { assertionObjects, assertionFunctions };
}
function collectSourceImports(ast) {
  const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
  return {
    ...collectTestImports(imports),
    ...collectAssertionImports(imports),
    libraryBindings: collectLibraryImports(imports),
  };
}
function makeSourceRegistration(node, ancestors, { bindings, namespaces, byNode, file, tags }) {
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  let name = null;
  if (callee.type === 'Identifier') name = bindings.get(callee.name);
  else if (callee.type === 'MemberExpression' && !callee.computed && namespaces.has(callee.object.name))
    name = callee.property.name;
  const parent = ancestors.map((item) => byNode.get(item)).findLast(Boolean);
  const subtest =
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.name === 'test' &&
    parent?.callback?.params[0]?.name === callee.object.name;
  if (!['test', 'it'].includes(name) && !subtest) return null;
  const callback = [...node.arguments]
    .reverse()
    .find((item) => ['ArrowFunctionExpression', 'FunctionExpression'].includes(item.type));
  if (!callback || (callback.body.type !== 'BlockStatement' && callback.type !== 'ArrowFunctionExpression'))
    return null;
  const loops = ancestors.filter(
    (item) =>
      [
        'ForOfStatement',
        'ForInStatement',
        'ForStatement',
        'WhileStatement',
        'DoWhileStatement',
        'IfStatement',
        'SwitchStatement',
        'ConditionalExpression',
      ].includes(item.type) ||
      (item.type === 'CallExpression' &&
        item.callee.type === 'MemberExpression' &&
        ['forEach', 'map', 'flatMap'].includes(item.callee.property.name)),
  );
  return {
    node,
    callback,
    parent,
    id: `${file}:${node.loc.start.line}:${node.loc.start.column}`,
    titleExpressionSha256: parityAstHash(node.arguments[0]),
    title: node.arguments[0]?.value ?? null,
    kinds: kindsAt({ ...tags, regions: tags.regions.filter((region) => !region.partial) }, node.loc.start.line),
    loops,
    assertions: [],
    testBindings: bindings,
    testNamespaces: namespaces,
    statement: [...ancestors]
      .reverse()
      .find((item) => ['ExpressionStatement', 'ReturnStatement', 'VariableDeclaration'].includes(item.type)),
  };
}
function attachSourceAssertions(
  registration,
  { byNode, assertionObjects, assertionFunctions, source, libraryBindings, declaredNames },
) {
  registration.loopHeaders = registration.loops.map((item) => parityAstHash(generatorSkeleton(item, byNode)));
  function visit(node, initial = false) {
    if (!initial && byNode.has(node)) return;
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const imported =
        (callee.type === 'Identifier' && (assertionObjects.has(callee.name) || assertionFunctions.has(callee.name))) ||
        (callee.type === 'MemberExpression' && !callee.computed && assertionObjects.has(callee.object.name));
      const contextAssert =
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'MemberExpression' &&
        callee.object.property.name === 'assert' &&
        callee.object.object.name === registration.callback.params[0]?.name;
      if (imported || contextAssert)
        registration.assertions.push({
          sha256: parityAstHash(node),
          node,
          text: source.slice(...node.range),
          libraryBindings,
          declaredNames,
        });
    }
    for (const child of childNodes(node)) visit(child);
  }
  visit(registration.callback.body, true);
}
export function describeParitySource(source, file = 'fixture.test.mjs') {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const tags = parseTestKinds(source),
    { bindings, namespaces, assertionObjects, assertionFunctions, libraryBindings } = collectSourceImports(ast),
    declaredNames = new Set();
  const registrations = [],
    declarations = [],
    byNode = new Map(),
    identifiers = new Set();
  function visit(node, ancestors = []) {
    if (node.type === 'Identifier') identifiers.add(node.name);
    const registration = makeSourceRegistration(node, ancestors, { bindings, namespaces, byNode, file, tags });
    if (registration) {
      registrations.push(registration);
      byNode.set(node, registration);
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init)
      declarations.push({
        name: node.id.name,
        initializer: node.init,
        initializerAstSha256: parityAstHash(node.init),
        ownerTitle: ancestors.map((item) => byNode.get(item)).findLast(Boolean)?.titleExpressionSha256 ?? null,
      });
    if (['VariableDeclarator', 'FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id?.name)
      declaredNames.add(node.id.name);
    for (const child of childNodes(node)) visit(child, [...ancestors, node]);
  }
  visit(ast);
  for (const registration of registrations)
    attachSourceAssertions(registration, {
      byNode,
      assertionObjects,
      assertionFunctions,
      source,
      libraryBindings,
      declaredNames,
    });
  const model = { ast, source, sourceSha256: parityHash(source), tags, registrations, declarations, identifiers };
  modelSourcePaths.set(model, file);
  return model;
}
function generatorSkeleton(node, registrations) {
  if (registrations.has(node))
    return { type: 'ParityRegistration', titleExpressionSha256: registrations.get(node).titleExpressionSha256 };
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (Array.isArray(value))
        return [key, value.map((item) => (item?.type ? generatorSkeleton(item, registrations) : item))];
      return [key, value?.type ? generatorSkeleton(value, registrations) : value];
    }),
  );
}
function registration(model, spec) {
  const candidates = model.registrations.filter(
    (row) =>
      row.titleExpressionSha256 === spec.titleExpressionSha256 &&
      (!spec.parentTitleExpressionSha256 || row.parent?.titleExpressionSha256 === spec.parentTitleExpressionSha256),
  );
  check(candidates.length === 1, candidates.length ? 'ambiguous-registration' : 'missing-registration');
  return candidates[0];
}
function sourceBindings(model, specifications) {
  for (const spec of specifications) {
    check(typeof spec.name === 'string' && SHA.test(spec.initializerAstSha256), 'invalid-source-binding');
    const matches = model.declarations.filter(
      (item) => item.name === spec.name && (spec.ownerTitle === undefined || item.ownerTitle === spec.ownerTitle),
    );
    check(matches.length === 1, 'ambiguous-source-binding');
    check(matches[0].initializerAstSha256 === spec.initializerAstSha256, 'changed-source-binding');
  }
}
function exactObjectKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function validNpmVersion(version) {
  if (typeof version !== 'string') return false;
  const text = String(version);
  const separator = text?.indexOf('-') ?? -1;
  const core = separator < 0 ? text : (text?.slice(0, separator) ?? '');
  const prerelease = separator < 0 ? null : (text?.slice(separator + 1) ?? '');
  return (
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(core) &&
    (prerelease === null || /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u.test(prerelease))
  );
}
function officialNpmPackage(pkg) {
  if (
    !exactObjectKeys(pkg, ['ecosystem', 'id', 'version', 'source', 'sha256', 'integrity', 'executedSourceClosure']) ||
    !Array.isArray(pkg.executedSourceClosure) ||
    !pkg.executedSourceClosure.every((item) => exactObjectKeys(item, ['path', 'sha256']))
  )
    return false;
  if (
    pkg?.ecosystem !== 'npm' ||
    typeof pkg.id !== 'string' ||
    !/^@microsoft\/[a-z0-9][a-z0-9._-]*$/u.test(pkg.id) ||
    !validNpmVersion(pkg.version) ||
    !SHA.test(pkg.sha256) ||
    typeof pkg.integrity !== 'string'
  )
    return false;
  const name = pkg.id.slice('@microsoft/'.length);
  if (pkg.source !== `https://registry.npmjs.org/@microsoft/${name}/-/${name}-${pkg.version}.tgz`) return false;
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/u.exec(pkg.integrity);
  if (!match) return false;
  const digest = Buffer.from(match[1], 'base64');
  if (digest.length !== 64 || digest.toString('base64') !== match[1]) return false;
  if (!Array.isArray(pkg.executedSourceClosure) || !pkg.executedSourceClosure.length) return false;
  const paths = new Set();
  for (const entry of pkg.executedSourceClosure) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      entry.path.includes('\\') ||
      entry.path.startsWith('/') ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !SHA.test(entry.sha256) ||
      paths.has(entry.path)
    )
      return false;
    paths.add(entry.path);
  }
  return true;
}
function verifyCdnProducer(root, proof, expectedHash) {
  const producer = proof.producerWitness,
    closure = proof.producerClosureWitnesses;
  check(
    producer && SHA.test(producer.sha256) && producer.sha256 === expectedHash && Array.isArray(closure),
    'cdn-executed-bytes-required',
  );
  const advertised = new Map();
  for (const entry of closure) {
    check(
      entry &&
        typeof entry.path === 'string' &&
        SHA.test(entry.sha256) &&
        !advertised.has(entry.path) &&
        entry.path !== producer.path,
      'cdn-producer-closure-required',
    );
    advertised.set(entry.path, entry.sha256);
  }
  const visited = new Set();
  function visit(relative, hash) {
    check(typeof relative === 'string' && /\.(?:mjs|js)$/u.test(relative), 'cdn-producer-closure-unsupported');
    const absolute = confined(root, relative),
      canonical = path.relative(root, absolute).replaceAll(path.sep, '/');
    check(relative === canonical && !visited.has(canonical), 'cdn-producer-closure-unsupported');
    visited.add(canonical);
    const bytes = fs.readFileSync(absolute);
    check(parityHash(bytes) === hash, 'cdn-executed-bytes-mismatch');
    const ast = parse(bytes.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    function scan(node) {
      check(
        node.type !== 'ImportExpression' &&
          !(
            node.type === 'Identifier' &&
            ['require', 'eval', 'Function', 'WebAssembly', 'Worker', 'process', 'globalThis'].includes(node.name)
          ),
        'cdn-producer-closure-unsupported',
      );
      childNodes(node).forEach(scan);
    }
    scan(ast);
    for (const node of ast.body) {
      if (!(
        node.type === 'ImportDeclaration' ||
        (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
      ))
        continue;
      const source = node.source.value;
      if (source.startsWith('node:')) {
        check(
          [
            'node:fs',
            'node:fs/promises',
            'node:crypto',
            'node:path',
            'node:url',
            'node:buffer',
            'node:assert',
            'node:assert/strict',
          ].includes(source),
          'cdn-producer-closure-unsupported',
        );
        continue;
      }
      check(
        (source.startsWith('./') || source.startsWith('../')) && !/[?#\\]/u.test(source),
        'cdn-producer-closure-unsupported',
      );
      const child = path.relative(root, path.resolve(path.dirname(absolute), source)).replaceAll(path.sep, '/');
      check(advertised.has(child), 'cdn-producer-closure-required');
      if (!visited.has(child)) visit(child, advertised.get(child));
    }
  }
  visit(producer.path, producer.sha256);
  check(visited.size === advertised.size + 1, 'cdn-producer-closure-required');
}
function checkPublicGitPath(root, relative, rootRel) {
  const git = resolveGitExecutable();
  const repository = spawnSync(git, ['--no-optional-locks', 'rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (fs.existsSync(path.join(root, '.git')))
    check(repository.status === 0 && repository.stdout.trim() === 'true', 'cdn-public-path-policy-unavailable');
  if (repository.status !== 0 || repository.stdout.trim() !== 'true') return;
  for (const candidate of new Set([relative, rootRel])) {
    const ignored = spawnSync(git, ['--no-optional-locks', 'check-ignore', '--no-index', '-q', '--', candidate], {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
    });
    check(
      ignored.status === 1,
      ignored.status === 0 ? 'cdn-public-path-required' : 'cdn-public-path-policy-unavailable',
    );
  }
}
function requirePublicCdnPath(root, relative, evidenceRoot, checkIgnored = false) {
  check(
    typeof relative === 'string' &&
      relative &&
      !path.isAbsolute(relative) &&
      relative.split(/[\\/]/u).every((part) => part && !part.startsWith('.')),
    'cdn-public-path-required',
  );
  const absolute = confined(root, relative),
    parent = fs.realpathSync(path.dirname(absolute));
  const physical = fs.existsSync(absolute) ? fs.realpathSync(absolute) : path.join(parent, path.basename(absolute));
  const rootReal = fs.realpathSync(root),
    rootRel = path.relative(rootReal, physical);
  check(
    rootRel && rootRel !== '..' && !rootRel.startsWith('..' + path.sep) && !path.isAbsolute(rootRel),
    'cdn-public-path-required',
  );
  if (evidenceRoot) {
    const privateReal = fs.realpathSync(evidenceRoot),
      privateRel = path.relative(privateReal, physical);
    check(
      privateRel === '..' || privateRel.startsWith('..' + path.sep) || path.isAbsolute(privateRel),
      'cdn-public-path-required',
    );
  }
  if (checkIgnored) checkPublicGitPath(root, relative, rootRel);
  return absolute;
}
function validateCdnPublicShape(proof, capsule) {
  const exact = exactObjectKeys;
  check(
    exact(proof.package, ['ecosystem', 'id', 'manifests', 'executedSourceClosure']) &&
      Array.isArray(proof.package.manifests) &&
      proof.package.manifests.every((item) => exact(item, ['source', 'version', 'sha256', 'bodyBase64'])) &&
      Array.isArray(proof.package.executedSourceClosure) &&
      proof.package.executedSourceClosure.every((item) => exact(item, ['source', 'sha256', 'size'])) &&
      Array.isArray(proof.facts) &&
      proof.facts.every((item) => exact(item, ['id', 'pointer', 'sha256', 'replicatedPointers'])),
    'cdn-public-shape-invalid',
  );
  check(
    proof.packagePointer === '/package' &&
      jsonHash(proof.capturePointers) === jsonHash(['/captures/0/receiptSha256', '/captures/1/receiptSha256']) &&
      proof.facts.every(
        (fact) =>
          ID.test(fact.id) &&
          fact.pointer === `/captures/0/behaviorFacts/${fact.id}` &&
          jsonHash(fact.replicatedPointers) ===
            jsonHash([`/captures/0/behaviorFacts/${fact.id}`, `/captures/1/behaviorFacts/${fact.id}`]),
      ),
    'cdn-public-shape-invalid',
  );
  const ids = proof.facts.map((fact) => fact.id).sort(compareCodeUnits);
  check(
    exact(capsule, ['package', 'captures']) &&
      Array.isArray(capsule.captures) &&
      capsule.captures.length === 2 &&
      new Set(ids).size === ids.length &&
      capsule.captures.every(
        (capture) =>
          exact(capture, ['receiptSha256', 'behaviorFacts']) &&
          capture.behaviorFacts &&
          typeof capture.behaviorFacts === 'object' &&
          !Array.isArray(capture.behaviorFacts) &&
          jsonHash(Object.keys(capture.behaviorFacts).sort(compareCodeUnits)) === jsonHash(ids),
      ),
    'cdn-public-shape-invalid',
  );
}
function verifyCdnPrivate(root, proof, capsule) {
  check(
    typeof proof.publisherReadsPointer === 'string' &&
      typeof proof.runsPointer === 'string' &&
      proof.runsPointer.startsWith('/') &&
      !proof.runsPointer.endsWith('/'),
    'cdn-receipt-bindings-required',
  );
  const publisherReads = pointer(capsule, proof.publisherReadsPointer),
    runs = pointer(capsule, proof.runsPointer);
  check(validateMicrosoftCdnArtifact(proof.package, publisherReads, runs), 'official-package-provenance-required');
  check(
    jsonHash(proof.capturePointers) ===
      jsonHash([`${proof.runsPointer}/0/receiptSha256`, `${proof.runsPointer}/1/receiptSha256`]),
    'cdn-run-roots-required',
  );
  check(
    Array.isArray(proof.runWitnesses) &&
      proof.runWitnesses.length === 2 &&
      proof.publisherWitness &&
      Array.isArray(proof.sourceCaptureWitnesses) &&
      proof.sourceCaptureWitnesses.length === 2,
    'cdn-independent-witnesses-required',
  );
  const witnesses = [proof.publisherWitness, ...proof.runWitnesses];
  const paths = witnesses.map((witness) => {
    check(
      witness && SHA.test(witness.sha256) && typeof witness.pointer === 'string',
      'cdn-independent-witnesses-required',
    );
    return fs.realpathSync(confined(root, witness.path));
  });
  const capturePaths = proof.sourceCaptureWitnesses.map((witness) => {
    check(
      witness && SHA.test(witness.sha256) && typeof witness.pointer === 'string',
      'cdn-independent-witnesses-required',
    );
    return fs.realpathSync(confined(root, witness.path));
  });
  check(
    new Set([...paths, ...capturePaths, fs.realpathSync(confined(root, proof.path))]).size === 6 &&
      new Set([...witnesses, ...proof.sourceCaptureWitnesses].map((witness) => witness.sha256)).size === 5,
    'cdn-independent-witnesses-required',
  );
  proof.sourceCaptureWitnesses.forEach((witness, index) => {
    const bytes = fs.readFileSync(capturePaths[index]),
      run = runs[index];
    check(
      witness.sha256 === run.result.sourceCaptureSha256 && parityHash(bytes) === witness.sha256,
      'cdn-source-capture-mismatch',
    );
    const result = Object.fromEntries(Object.entries(run.result).filter(([key]) => key !== 'sourceCaptureSha256'));
    const expectedCapture = {
      id: run.id,
      producerSha256: run.producerSha256,
      inputSha256: run.inputSha256,
      input: run.input,
      result,
    };
    check(
      jsonHash(pointer(JSON.parse(bytes), witness.pointer)) === jsonHash(expectedCapture),
      'cdn-source-capture-mismatch',
    );
  });
  verifyCdnProducer(root, proof, runs[0].producerSha256);
  check(
    proof.contextWitness &&
      SHA.test(proof.contextWitness.sha256) &&
      proof.contextWitness.sha256 === runs[0].input.contextSha256 &&
      parityHash(fs.readFileSync(confined(root, proof.contextWitness.path))) === proof.contextWitness.sha256,
    'cdn-context-bytes-mismatch',
  );
  check(Array.isArray(proof.assetWitnesses), 'cdn-executed-bytes-required');
  const inventory = runs[0].input.executedScripts;
  check(
    proof.assetWitnesses.length === inventory.length &&
      new Set(proof.assetWitnesses.map((item) => item.source)).size === inventory.length,
    'cdn-executed-bytes-required',
  );
  for (const witness of proof.assetWitnesses) {
    const entry = inventory.find((item) => item.source === witness.source);
    check(entry && SHA.test(witness.sha256) && witness.sha256 === entry.sha256, 'cdn-executed-bytes-mismatch');
    const bytes = fs.readFileSync(confined(root, witness.path));
    check(bytes.length === entry.size && parityHash(bytes) === entry.sha256, 'cdn-executed-bytes-mismatch');
  }
  const expected = [publisherReads, ...runs];
  witnesses.forEach((witness, index) => {
    const bytes = fs.readFileSync(paths[index]);
    check(parityHash(bytes) === witness.sha256, 'cdn-stale-witness');
    check(jsonHash(pointer(JSON.parse(bytes), witness.pointer)) === jsonHash(expected[index]), 'cdn-witness-mismatch');
  });
  return { publisherReads, runs };
}
function legacyScalarReplicas(root, proof, capsule, fact, witness) {
  check(
    witness &&
      jsonHash(Object.keys(witness).sort(compareCodeUnits)) ===
        jsonHash(['factId', 'legacyProofSha256', 'path', 'sha256']) &&
      witness.legacyProofSha256 === proof.sha256 &&
      witness.factId === fact.id &&
      typeof witness.path === 'string' &&
      SHA.test(witness.sha256),
    'independent-fact-replicas-required',
  );
  const bytes = fs.readFileSync(requirePublicCdnPath(root, witness.path, null, false));
  check(parityHash(bytes) === witness.sha256, 'stale-supplemental-witness');
  const supplement = JSON.parse(bytes);
  const match = /^\/cases\/(\d+)\/cause$/u.exec(fact.pointer);
  check(match && fact.equalBodyHashesPointer === `/cases/${match[1]}/nativeBodySha256`, 'invalid-supplemental-witness');
  const original = capsule.cases?.[Number(match[1])];
  check(
    original &&
      supplement.schemaVersion === 2 &&
      supplement.source?.existingFixtureSha256 === proof.sha256 &&
      Array.isArray(supplement.captures) &&
      supplement.captures.length === 2 &&
      Array.isArray(original.nativeBodySha256) &&
      original.nativeBodySha256.length === 2 &&
      proof.capturePointers.length === 2,
    'invalid-supplemental-witness',
  );
  for (let i = 0; i < 2; i++) {
    const capture = supplement.captures[i];
    const cases = capture?.cases?.filter((row) => row.id === original.id);
    const row = cases?.[0];
    check(
      capture?.runSha256 === pointer(capsule, proof.capturePointers[i]) &&
        cases?.length === 1 &&
        row.sourceDirective?.originalCaseIndex === Number(match[1]) &&
        ['field', 'token', 'encoding', 'method'].every((key) => row.sourceDirective[key] === original[key]) &&
        row.nativeType === 'Edm.Boolean' &&
        row.facts?.cause === original.cause &&
        SHA.test(row.responseBodySha256) &&
        row.responseBodySha256 === original.nativeBodySha256[i],
      'invalid-supplemental-witness',
    );
  }
}
function preparePrivateCdnProof(root, proof, context, receipts) {
  check(context.evidenceRoot && context.prepared, 'cdn-private-evidence-root-required');
  const privateRoot = path.resolve(context.evidenceRoot);
  check(fs.statSync(privateRoot).isDirectory(), 'cdn-private-evidence-root-required');
  const privateSpec = proof.privateEvidence;
  check(SHA.test(privateSpec.bundleSha256), 'cdn-private-evidence-invalid');
  const privateBytes = fs.readFileSync(confined(privateRoot, privateSpec.bundlePath));
  check(parityHash(privateBytes) === privateSpec.bundleSha256, 'cdn-private-evidence-stale');
  const privateCapsule = JSON.parse(privateBytes);
  const privateProof = {
    ...privateSpec,
    path: privateSpec.bundlePath,
    package: proof.package,
    capturePointers: [`${privateSpec.runsPointer}/0/receiptSha256`, `${privateSpec.runsPointer}/1/receiptSha256`],
  };
  const { publisherReads, runs } = verifyCdnPrivate(privateRoot, privateProof, privateCapsule);
  check(jsonHash(receipts) === jsonHash(runs.map((run) => run.receiptSha256)), 'cdn-public-run-binding-mismatch');
  check(
    Array.isArray(privateSpec.factBindings) && privateSpec.factBindings.length === proof.facts.length,
    'cdn-private-facts-required',
  );
  for (const fact of proof.facts) {
    const matches = privateSpec.factBindings.filter((item) => item.id === fact.id);
    check(
      matches.length === 1 &&
        Array.isArray(matches[0].pointers) &&
        matches[0].pointers.length === 2 &&
        matches[0].pointers.every(
          (selector, index) =>
            selector.startsWith(`${privateSpec.runsPointer}/${index}/result/behaviorFacts/`) &&
            selector.length > `${privateSpec.runsPointer}/${index}/result/behaviorFacts/`.length &&
            jsonHash(pointer(privateCapsule, selector)) === fact.sha256,
        ),
      'cdn-private-fact-mismatch',
    );
  }
  check(typeof proof.portableReceiptPath === 'string', 'cdn-portable-receipt-required');
  const receipt = {
    version: 1,
    kind: 'microsoft-cdn-reviewed-derivation',
    capsuleSha256: proof.sha256,
    packageSha256: jsonHash(proof.package),
    publisherReadsSha256: jsonHash(publisherReads),
    producerSha256: runs[0].producerSha256,
    contextSha256: runs[0].input.contextSha256,
    executionInventorySha256: jsonHash(runs[0].input.executedScripts),
    runReceiptSha256: receipts,
    facts: proof.facts.map(({ id, sha256 }) => ({ id, sha256 })),
  };
  const receiptText = JSON.stringify(receipt, null, 2) + '\n';
  const portableProof = {
    path: proof.path,
    sha256: proof.sha256,
    mode: proof.mode,
    package: proof.package,
    packagePointer: proof.packagePointer,
    capturePointers: proof.capturePointers,
    facts: proof.facts,
    portableReceipt: { path: proof.portableReceiptPath, sha256: parityHash(receiptText) },
  };
  context.prepared.set(proof, {
    portableProof,
    receipt: { path: proof.portableReceiptPath, after: receiptText },
  });
}
function validatePortableCdnProof(root, proof, context, receipts) {
  check(!context.prepared, 'cdn-private-evidence-root-required');
  check(proof.portableReceipt && SHA.test(proof.portableReceipt.sha256), 'cdn-portable-receipt-required');
  const receiptBytes = fs.readFileSync(confined(root, proof.portableReceipt.path));
  check(parityHash(receiptBytes) === proof.portableReceipt.sha256, 'cdn-portable-receipt-stale');
  const receipt = JSON.parse(receiptBytes);
  check(
    receipt.version === 1 &&
      receipt.kind === 'microsoft-cdn-reviewed-derivation' &&
      receipt.capsuleSha256 === proof.sha256 &&
      receipt.packageSha256 === jsonHash(proof.package) &&
      jsonHash(receipt.runReceiptSha256) === jsonHash(receipts) &&
      jsonHash(receipt.facts) === jsonHash(proof.facts.map(({ id, sha256 }) => ({ id, sha256 }))),
    'cdn-portable-receipt-mismatch',
  );
}
function proveOfficialPackage(root, proof, context, capsule, receipts) {
  if (proof.package?.ecosystem === 'npm')
    check(officialNpmPackage(proof.package), 'official-package-provenance-required');
  else if (proof.package?.ecosystem === 'microsoft-cdn') {
    validateCdnPublicShape(proof, capsule);
    requirePublicCdnPath(root, proof.path, context.evidenceRoot, Boolean(context.prepared));
    requirePublicCdnPath(
      root,
      proof.privateEvidence ? proof.portableReceiptPath : proof.portableReceipt?.path,
      context.evidenceRoot,
      Boolean(context.prepared),
    );
    if (proof.privateEvidence) preparePrivateCdnProof(root, proof, context, receipts);
    else validatePortableCdnProof(root, proof, context, receipts);
  } else
    check(
      proof.package &&
        typeof proof.package.id === 'string' &&
        proof.package.id.startsWith('Microsoft.') &&
        typeof proof.package.version === 'string' &&
        SHA.test(proof.package.sha256) &&
        typeof proof.package.source === 'string' &&
        /^https:\/\/(?:api\.nuget\.org|www\.nuget\.org|github\.com\/microsoft)\//u.test(proof.package.source),
      'official-package-provenance-required',
    );
  check(
    typeof proof.packagePointer === 'string' &&
      jsonHash(pointer(capsule, proof.packagePointer)) === jsonHash(proof.package),
    'official-package-not-bound-to-receipt',
  );
}
function prove(root, proof, context = {}) {
  check(SHA.test(proof.sha256), 'invalid-proof-sha');
  const bytes = fs.readFileSync(confined(root, proof.path));
  check(parityHash(bytes) === proof.sha256, 'stale-proof-sha');
  const capsule = JSON.parse(bytes);
  check(['reproduced-native', 'official-package'].includes(proof.mode), 'invalid-proof-mode');
  check(Array.isArray(proof.capturePointers) && proof.capturePointers.length >= 2, 'independent-receipts-required');
  for (const selector of proof.capturePointers)
    check(
      typeof selector === 'string' && !/(?:body|response|stdout)sha256$/iu.test(selector),
      'response-hash-is-not-run-receipt',
    );
  const captureRoots = proof.capturePointers.map((selector) => {
    check(
      typeof selector === 'string' && selector.startsWith('/') && selector.lastIndexOf('/') > 0,
      'independent-capture-roots-required',
    );
    return selector.slice(0, selector.lastIndexOf('/'));
  });
  check(
    new Set(captureRoots).size === captureRoots.length &&
      captureRoots.every((root, i) => captureRoots.every((other, j) => i === j || !other.startsWith(root + '/'))),
    'independent-capture-roots-required',
  );
  const receipts = proof.capturePointers.map((selector) => {
    check(!/(?:body|response|stdout)sha256$/iu.test(selector), 'response-hash-is-not-run-receipt');
    const value = pointer(capsule, selector);
    check(typeof value === 'string' && SHA.test(value), 'invalid-run-receipt');
    return value;
  });
  check(new Set(receipts).size >= 2, 'independent-receipts-required');
  if (proof.mode === 'official-package') proveOfficialPackage(root, proof, context, capsule, receipts);
  check(Array.isArray(proof.facts) && proof.facts.length, 'proof-facts-required');
  for (const fact of proof.facts) {
    check(ID.test(fact.id) && SHA.test(fact.sha256), 'invalid-proof-fact');
    check(jsonHash(pointer(capsule, fact.pointer)) === fact.sha256, 'changed-proof-fact');
    if (Array.isArray(fact.replicatedPointers)) {
      check(
        fact.replicatedPointers.length === proof.capturePointers.length &&
          new Set(fact.replicatedPointers).size === fact.replicatedPointers.length,
        'independent-fact-replicas-required',
      );
      fact.replicatedPointers.forEach((selector, index) => {
        const captureRoot = proof.capturePointers[index].slice(0, proof.capturePointers[index].lastIndexOf('/'));
        check(captureRoot && selector.startsWith(captureRoot + '/'), 'fact-not-bound-to-independent-capture');
        check(jsonHash(pointer(capsule, selector)) === fact.sha256, 'unreproduced-proof-fact');
      });
    } else legacyScalarReplicas(root, proof, capsule, fact, context.supplementalWitness);
  }
  return proof.facts.map((fact) => fact.id);
}
function isHashGuard(assertion) {
  const n = assertion.node;
  const library = (name, source, exported) =>
    assertion.libraryBindings.get(name)?.source === source && assertion.libraryBindings.get(name)?.name === exported;
  if (
    !library('createHash', 'node:crypto', 'createHash') ||
    ['createHash', 'readFile', 'readFileSync', 'fs', 'URL', 'JSON'].some((name) => assertion.declaredNames.has(name))
  )
    return false;
  const member = (node, name) => node?.type === 'MemberExpression' && !node.computed && node.property.name === name;
  const call = (node, name) => node?.type === 'CallExpression' && member(node.callee, name);
  const literal = (node, value) => node?.type === 'Literal' && node.value === value;
  const metaUrl = (node) =>
    member(node, 'url') &&
    node.object.type === 'MetaProperty' &&
    node.object.meta.name === 'import' &&
    node.object.property.name === 'meta';
  if (!(
    member(n.callee, 'equal') &&
    n.arguments.length === 2 &&
    typeof n.arguments[1]?.value === 'string' &&
    SHA.test(n.arguments[1].value)
  ))
    return false;
  const digest = n.arguments[0];
  if (!(call(digest, 'digest') && digest.arguments.length === 1 && literal(digest.arguments[0], 'hex'))) return false;
  const update = digest.callee.object;
  if (!(call(update, 'update') && update.arguments.length === 1)) return false;
  const hash = update.callee.object;
  if (!(
    hash.type === 'CallExpression' &&
    hash.callee.type === 'Identifier' &&
    hash.callee.name === 'createHash' &&
    hash.arguments.length === 1 &&
    literal(hash.arguments[0], 'sha256')
  ))
    return false;
  const data = update.arguments[0];
  // An added await changes scheduling; it cannot be transparent scaffolding.
  if (data.type === 'AwaitExpression') return false;
  if (!(
    data.type === 'CallExpression' &&
    data.arguments.length === 1 &&
    ((data.callee.type === 'Identifier' &&
      (library(data.callee.name, 'node:fs/promises', 'readFile') ||
        library(data.callee.name, 'node:fs', 'readFileSync'))) ||
      (member(data.callee, 'readFileSync') &&
        data.callee.object.name === 'fs' &&
        ['default', '*'].includes(assertion.libraryBindings.get('fs')?.name) &&
        assertion.libraryBindings.get('fs')?.source === 'node:fs'))
  ))
    return false;
  const url = data.arguments[0];
  return (
    url.type === 'NewExpression' &&
    url.callee.name === 'URL' &&
    url.arguments.length === 2 &&
    typeof url.arguments[0]?.value === 'string' &&
    metaUrl(url.arguments[1])
  );
}
function guardDescriptors(node) {
  check(
    node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === IMPORT &&
      node.arguments.length === 2,
    'invalid-generated-guard',
  );
  const [url, data] = node.arguments;
  check(
    url.type === 'MemberExpression' &&
      !url.computed &&
      url.property.name === 'url' &&
      url.object.type === 'MetaProperty' &&
      url.object.meta.name === 'import' &&
      url.object.property.name === 'meta',
    'invalid-generated-guard',
  );
  const converted = (item) => {
    if (item.type === 'Literal' && (item.value === null || ['string', 'number', 'boolean'].includes(typeof item.value)))
      return item.value;
    if (
      item.type === 'UnaryExpression' &&
      item.operator === '-' &&
      item.prefix &&
      item.argument.type === 'Literal' &&
      typeof item.argument.value === 'number' &&
      Number.isFinite(item.argument.value)
    )
      return -item.argument.value;
    if (item.type === 'ArrayExpression')
      return item.elements.map((entry) => {
        check(entry, 'invalid-generated-guard');
        return converted(entry);
      });
    if (item.type === 'ObjectExpression') {
      const names = new Set();
      return Object.fromEntries(
        item.properties.map((entry) => {
          check(
            entry.type === 'Property' &&
              !entry.computed &&
              !entry.method &&
              !entry.shorthand &&
              entry.kind === 'init' &&
              (entry.key.type === 'Identifier' ||
                (entry.key.type === 'Literal' && typeof entry.key.value === 'string')),
            'invalid-generated-guard',
          );
          const key = entry.key.type === 'Identifier' ? entry.key.name : entry.key.value;
          check(!['__proto__', 'constructor', 'prototype'].includes(key), 'invalid-generated-guard');
          check(!names.has(key), 'invalid-generated-guard');
          names.add(key);
          return [key, converted(entry.value)];
        }),
      );
    }
    fail('invalid-generated-guard');
  };
  const value = converted(data);
  check(Array.isArray(value) && value.length, 'invalid-generated-guard');
  return value;
}
function canonicalRecordsMarker(call) {
  check(
    call?.type === 'CallExpression' &&
      call.callee?.name === RECORDS_IMPORT &&
      call.arguments.length === 2 &&
      call.arguments[0]?.type === 'ObjectExpression' &&
      call.arguments[0].properties.length > 0 &&
      call.arguments[0].properties.every(
        (property) =>
          property.type === 'Property' &&
          property.shorthand &&
          !property.computed &&
          property.value?.type === 'Identifier',
      ),
    'invalid-records-fixture-marker',
  );
  const names = call.arguments[0].properties.map((property) => property.value.name);
  check(new Set(names).size === names.length, 'invalid-records-fixture-marker');
  const fake = parse(`${IMPORT}(import.meta.url, []);`, { ecmaVersion: 'latest', sourceType: 'module' }).body[0]
    .expression;
  fake.arguments[1].elements = [call.arguments[1]];
  const [fixture] = guardDescriptors(fake);
  return parse(`${RECORDS_IMPORT}({${names.join(',')}}, ${JSON.stringify(fixture)});`, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  }).body[0].expression;
}
function strippedBody(
  row,
  originalGuards = new Set(),
  replacements = new Map(),
  concise = false,
  retained = new Set(),
) {
  function unwrap(node) {
    if (!node || typeof node !== 'object') return node;
    if (replacements.has(node)) return unwrap(replacements.get(node));
    if (node.type === 'CallExpression' && node.callee?.name === RECORDS_IMPORT) return canonicalRecordsMarker(node);
    if (Array.isArray(node))
      return node.flatMap((item) => {
        const call =
          item?.type === 'BlockStatement' && item.body[0]?.type === 'ExpressionStatement' && item.body[0].expression;
        if (call?.type === 'CallExpression' && call.callee?.name === REGION_IMPORT) {
          guardDescriptors({ ...call, callee: { type: 'Identifier', name: IMPORT } });
          return item.body.slice(1).map(unwrap);
        }
        return [unwrap(item)];
      });
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, unwrap(value)]));
  }
  if (row.callback.body.type !== 'BlockStatement') return unwrap(row.callback.body);
  if (concise) {
    const body = row.callback.body.body.filter(
      (statement) =>
        !(
          statement.type === 'ExpressionStatement' &&
          statement.expression.type === 'CallExpression' &&
          [IMPORT, REGION_IMPORT, CASE_IMPORT].includes(statement.expression.callee.name)
        ),
    );
    check(body.length === 1 && body[0].type === 'ReturnStatement' && body[0].argument, 'changed-concise-callback');
    return unwrap(body[0].argument);
  }
  return unwrap({
    ...row.callback.body,
    body: row.callback.body.body.filter((statement) => {
      if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') return true;
      const call = statement.expression;
      if (retained.has(parityAstHash(call))) return false;
      if (call.callee?.name === CASE_IMPORT) {
        caseGuardDescriptors(call);
        return false;
      }
      if (call.callee.type === 'Identifier' && call.callee.name === IMPORT) {
        guardDescriptors(call);
        return false;
      }
      return !row.assertions.some(
        (item) => item.node === call && isHashGuard(item) && !originalGuards.has(item.sha256),
      );
    }),
  });
}
function caseGuardDescriptors(call) {
  check(
    call.type === 'CallExpression' &&
      call.callee?.type === 'Identifier' &&
      call.callee.name === CASE_IMPORT &&
      call.arguments.length === 5 &&
      call.arguments[1]?.type === 'Identifier' &&
      call.arguments[2]?.type === 'ArrayExpression' &&
      call.arguments[3]?.type === 'ObjectExpression',
    'invalid-case-parity-marker',
  );
  const indices = call.arguments[2].elements.map((item) => (item?.type === 'Literal' ? item.value : null));
  check(
    indices.length &&
      indices.every((item, index) => Number.isInteger(item) && item >= 0 && (!index || item > indices[index - 1])),
    'invalid-case-parity-marker',
  );
  const descriptors = guardDescriptors({
    ...call,
    callee: { type: 'Identifier', name: IMPORT },
    arguments: [call.arguments[0], call.arguments[4]],
  });
  const selection = descriptors[0]?.caseSelection;
  check(
    descriptors.length === 1 &&
      selection &&
      Array.isArray(selection.selected) &&
      jsonHash(selection.selected.map((item) => item.caseIndex)) === jsonHash(indices) &&
      call.arguments[1].name === selection.source &&
      Array.isArray(selection.names) &&
      jsonHash(
        call.arguments[3].properties.map((item) =>
          item.type === 'Property' && item.shorthand && !item.computed && item.value.type === 'Identifier'
            ? item.value.name
            : null,
        ),
      ) === jsonHash(selection.names),
    'invalid-case-parity-marker',
  );
  return descriptors;
}
// Accept the original source guard and its assertion-wrapped equivalent only.
// The wrapper's assert and guard identifiers must resolve to the real imports.
function isSourceGuardCallback(model, callback) {
  const direct = parse(`const guard = () => { ${SOURCE_IMPORT}(import.meta.url); };`, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  }).body[0].declarations[0].init;
  if (parityAstHash(callback) === parityAstHash(direct)) return true;
  if (
    callback?.type !== 'ArrowFunctionExpression' ||
    callback.async ||
    callback.generator ||
    callback.params.length !== 0 ||
    callback.body.type !== 'BlockStatement' ||
    callback.body.body.length !== 1
  )
    return false;
  const outer = callback.body.body[0];
  const call = outer?.type === 'ExpressionStatement' ? outer.expression : null;
  const member = call?.callee;
  const inner = call?.arguments?.[0];
  if (
    call?.type !== 'CallExpression' ||
    call.arguments.length !== 1 ||
    call.optional ||
    member?.type !== 'MemberExpression' ||
    member.computed ||
    member.optional ||
    member.object?.type !== 'Identifier' ||
    member.property?.name !== 'doesNotThrow' ||
    inner?.type !== 'ArrowFunctionExpression' ||
    inner.async ||
    inner.generator ||
    inner.params.length !== 0 ||
    inner.body?.type !== 'CallExpression' ||
    inner.body.optional ||
    inner.body.callee?.name !== SOURCE_IMPORT ||
    inner.body.arguments.length !== 1 ||
    parityAstHash(inner.body.arguments[0]) !== parityAstHash(direct.body.body[0].expression.arguments[0])
  )
    return false;
  const scopes = analyzeScopes(model.ast, { ecmaVersion: 2022, sourceType: 'module' });
  const references = scopes.scopes.flatMap((scope) => scope.references);
  const parents = new Map();
  function collectParents(node) {
    for (const child of childNodes(node)) {
      parents.set(child, node);
      collectParents(child);
    }
  }
  collectParents(model.ast);
  const resolveImport = (identifier, sources, imported) => {
    const ref = references.find((item) => item.identifier === identifier);
    const definition = ref?.resolved?.defs?.[0];
    return (
      ref?.resolved?.defs.length === 1 &&
      definition?.type === 'ImportBinding' &&
      sources.includes(definition.parent?.source?.value) &&
      (imported
        ? definition.node?.imported?.name === imported
        : ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(definition.node?.type)) &&
      ref.resolved.references.every((item) => {
        const parent = parents.get(item.identifier);
        if (imported) return parent?.type === 'CallExpression' && parent.callee === item.identifier;
        const grandparent = parents.get(parent);
        return (
          parent?.type === 'MemberExpression' &&
          parent.object === item.identifier &&
          !parent.computed &&
          grandparent?.type === 'CallExpression' &&
          grandparent.callee === parent
        );
      })
    );
  };
  const source = model.ast.body.find(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === SOURCE_IMPORT),
  )?.source.value;
  if (typeof source !== 'string') return false;
  const sourceFile = modelSourcePaths.get(model);
  if (typeof sourceFile !== 'string') return false;
  const sourceName = String(source);
  const resolved = sourceName?.startsWith('file:')
    ? fileURLToPath(sourceName)
    : path.resolve(path.dirname(path.resolve(path.dirname(path.dirname(TOOL)), sourceFile)), sourceName);
  return (
    resolved === TOOL &&
    resolveImport(member.object, ['node:assert', 'node:assert/strict'], null) &&
    resolveImport(inner.body.callee, [source], 'assertParityBindingsFromSource')
  );
}
// Isolation depends on every registration, including callbacks outside the selected test.
function isolationRegistrationHash(model, originalGuards, conciseSpecs = []) {
  let generatedGuards = 0;
  const rows = model.registrations.filter((row) => {
    const call = row.node;
    const generated =
      typeof row.title === 'string' &&
      /^parity source bindings [a-f0-9]{16}$/u.test(row.title) &&
      call.arguments.length === 2 &&
      isSourceGuardCallback(model, row.callback);
    if (generated) generatedGuards++;
    return !generated;
  });
  check(generatedGuards <= 1, 'duplicate-source-guard');
  return jsonHash(
    rows.map((row) => {
      const concise = conciseSpecs.some(
        (spec) =>
          spec.titleExpressionSha256 === row.titleExpressionSha256 &&
          (!spec.parentTitleExpressionSha256 || spec.parentTitleExpressionSha256 === row.parent?.titleExpressionSha256),
      );
      const callback = { ...row.callback, body: strippedBody(row, originalGuards, new Map(), concise) };
      if (concise) callback.expression = true;
      return {
        parent: row.parent ? rows.indexOf(row.parent) : -1,
        call: parityAstHash({
          ...row.node,
          arguments: row.node.arguments.map((argument) => (argument === row.callback ? callback : argument)),
        }),
      };
    }),
  );
}
// Strip added Node crypto/filesystem imports only when every use is inside a recognized hash guard.
function proofOnlyImports(model, originalGuards, retained = new Set()) {
  const guards = new Set(
    model.registrations.flatMap((row) =>
      row.assertions
        .filter((item) => (isHashGuard(item) && !originalGuards.has(item.sha256)) || retained.has(item.node))
        .map((item) => item.node),
    ),
  );
  const imports = model.ast.body.filter(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.specifiers.length &&
      ((node.source.value === 'node:crypto' &&
        node.specifiers.every(
          (item) =>
            item.type === 'ImportSpecifier' && item.imported.name === 'createHash' && item.local.name === 'createHash',
        )) ||
        (node.source.value === 'node:fs' &&
          node.specifiers.every(
            (item) =>
              (item.type === 'ImportDefaultSpecifier' && item.local.name === 'fs') ||
              (item.type === 'ImportSpecifier' && item.imported.name === 'readFileSync'),
          )) ||
        (node.source.value === 'node:fs/promises' &&
          node.specifiers.every((item) => item.type === 'ImportSpecifier' && item.imported.name === 'readFile'))),
  );
  const safe = new Set();
  for (const declaration of imports) {
    const names = new Set(declaration.specifiers.map((item) => item.local.name));
    let valid = true,
      uses = 0;
    function visit(node, inGuard = false) {
      if (node === declaration) return;
      const guarded = inGuard || guards.has(node);
      if (node.type === 'Identifier' && names.has(node.name)) {
        if (!guarded) valid = false;
        else uses++;
      }
      childNodes(node).forEach((child) => visit(child, guarded));
    }
    visit(model.ast);
    if (valid && uses >= names.size) safe.add(declaration);
  }
  return safe;
}
// Bind the entire execution context, ignoring only the qualifier's recognizable scaffolding.
function moduleContextHash(
  model,
  {
    replacements = new Map(),
    ignored = new Set(),
    originalGuards = new Set(),
    conciseSpecs = [],
    retained = new Set(),
  } = {},
) {
  const conciseCallbacks = new Map();
  for (const spec of conciseSpecs) {
    const row = registration(model, spec);
    if (row.callback.body.type === 'BlockStatement') {
      const body = row.callback.body.body;
      check(
        body.length === 2 &&
          body[0].type === 'ExpressionStatement' &&
          body[0].expression.type === 'CallExpression' &&
          [IMPORT, REGION_IMPORT, CASE_IMPORT].includes(body[0].expression.callee.name) &&
          body[1].type === 'ReturnStatement' &&
          body[1].argument,
        'changed-concise-callback',
      );
      if (body[0].expression.callee.name === CASE_IMPORT) caseGuardDescriptors(body[0].expression);
      else guardDescriptors({ ...body[0].expression, callee: { type: 'Identifier', name: IMPORT } });
      conciseCallbacks.set(row.callback, body[1].argument);
    }
  }
  const proofImports = proofOnlyImports(model, originalGuards, retained);
  const guards = new Set(
    model.registrations.flatMap((row) =>
      row.assertions
        .filter((item) => (isHashGuard(item) && !originalGuards.has(item.sha256)) || retained.has(item.node))
        .map((item) => item.node),
    ),
  );
  function removableCall(call) {
    if (call?.type === 'CallExpression' && call.callee?.name === IMPORT) {
      guardDescriptors(call);
      return true;
    }
    if (call?.type === 'CallExpression' && call.callee?.name === CASE_IMPORT) {
      caseGuardDescriptors(call);
      return true;
    }
    return (
      guards.has(call) ||
      (call?.type === 'CallExpression' &&
        call.arguments[0]?.type === 'Literal' &&
        /^parity source bindings [a-f0-9]{16}$/u.test(call.arguments[0].value ?? '') &&
        call.arguments.length === 2 &&
        model.registrations.some(
          (row) => row.node === call && !row.parent && isSourceGuardCallback(model, row.callback),
        ))
    );
  }
  function cleanElement(item) {
    if (ignored.has(item) || proofImports.has(item)) return [];
    if (
      item?.type === 'ImportDeclaration' &&
      item.specifiers.length &&
      item.specifiers.every((specifier) =>
        [IMPORT, SOURCE_IMPORT, REGION_IMPORT, CASE_IMPORT].includes(specifier.local.name),
      ) &&
      typeof item.source.value === 'string' &&
      item.source.value.endsWith('/scripts/qualify-parity.mjs')
    )
      return [];
    if (item?.type === 'ExpressionStatement' && removableCall(item.expression)) return [];
    if (item?.type === 'BlockStatement' && item.body[0]?.type === 'ExpressionStatement') {
      const call = item.body[0].expression;
      if (call?.type === 'CallExpression' && call.callee?.name === REGION_IMPORT) {
        guardDescriptors({ ...call, callee: { type: 'Identifier', name: IMPORT } });
        return item.body.slice(1).map(clean);
      }
    }
    return [clean(item)];
  }
  function clean(node) {
    if (!node || typeof node !== 'object') return node;
    if (conciseCallbacks.has(node)) return clean({ ...node, expression: true, body: conciseCallbacks.get(node) });
    if (replacements.has(node)) return clean(replacements.get(node));
    if (node.type === 'CallExpression' && node.callee?.name === RECORDS_IMPORT) return canonicalRecordsMarker(node);
    if (Array.isArray(node)) return node.flatMap(cleanElement);
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, clean(value)]));
  }
  return parityAstHash(clean(model.ast));
}
function evaluateUniverseObject(node, env, evaluate) {
  const pairs = node.properties.map((item) => {
    check(
      item.type === 'Property' &&
        item.kind === 'init' &&
        !item.computed &&
        !item.method &&
        !item.shorthand &&
        (item.key.type === 'Identifier' || (item.key.type === 'Literal' && typeof item.key.value === 'string')),
      'unresolved-case-universe',
    );
    const key = item.key.type === 'Identifier' ? item.key.name : item.key.value;
    check(!['__proto__', 'constructor', 'prototype'].includes(key), 'unresolved-case-universe');
    return [key, evaluate(item.value, env)];
  });
  check(new Set(pairs.map(([key]) => key)).size === pairs.length, 'unresolved-case-universe');
  return Object.fromEntries(pairs);
}
function evaluateUniverseTemplate(node, env, evaluate) {
  return node.quasis
    .map(
      (part, i) => part.value.cooked + (i < node.expressions.length ? String(evaluate(node.expressions[i], env)) : ''),
    )
    .join('');
}
function validateUniverseRegistrationExecution(old, current) {
  for (const initial of [old, current])
    for (let row = initial; row; row = row.parent) {
      const expression = row.statement?.type === 'ExpressionStatement' && row.statement.expression;
      const direct = expression === row.node;
      const awaited = expression?.type === 'AwaitExpression' && expression.argument === row.node;
      check(
        row.node.arguments.length === 2 &&
          row.node.arguments[1] === row.callback &&
          row.callback.params.every((param) => param.type === 'Identifier') &&
          !row.callback.generator &&
          (row.parent ? awaited : direct),
        'unsupported-registration-execution',
      );
    }
}
function validateUniverseContext(old, current, spec, oldModel, newModel, fixtureBindings, verifiedCaseBody) {
  validateUniverseRegistrationExecution(old, current);
  const universe = spec.caseUniverse;
  check(
    universe &&
      Number.isInteger(universe.count) &&
      universe.count > 0 &&
      Array.isArray(universe.cases) &&
      universe.cases.length === universe.count &&
      jsonHash(universe.cases) === universe.casesSha256,
    'explicit-case-universe-required',
  );
  if (universe.selectedCaseIndices || universe.selectedCount !== undefined) fail('partial-universe-needs-region-plan');
  check(
    Array.isArray(universe.sourceBindings) && Array.isArray(universe.ancestorLoops),
    'explicit-universe-bindings-required',
  );
  check(universe.ancestorLoops.length === old.loopHeaders.length, 'incomplete-loop-universe');
  check(
    jsonHash(universe.ancestorLoops.map((item) => item.headerAstSha256)) === jsonHash(old.loopHeaders),
    'baseline-loop-header-mismatch',
  );
  if (verifiedCaseBody)
    check(
      current.loops.length === 1 && parityAstHash(current.loops[0]) === verifiedCaseBody.candidateLoopSha256,
      'changed-loop-header',
    );
  else check(jsonHash(old.loopHeaders) === jsonHash(current.loopHeaders), 'changed-loop-header');
  if (old.loopHeaders.length)
    check(universe.sourceBindings.length > 0 || universe.count === 1, 'generator-source-binding-required');
  for (const name of fixtureBindings.keys()) {
    let usedInCallback = false;
    function inspect(node) {
      if (node.type === 'Identifier' && node.name === name) usedInCallback = true;
      childNodes(node).forEach(inspect);
    }
    inspect(old.callback.body);
    check(!usedInCallback, 'corrected-binding-usage-unsupported');
  }
  const activeFixture = old.loops.some(
    (loop) =>
      loop.type === 'ForOfStatement' && loop.right.type === 'Identifier' && fixtureBindings.has(loop.right.name),
  );
  sourceBindings(oldModel, universe.sourceBindings);
  sourceBindings(
    newModel,
    universe.sourceBindings.map((binding) => {
      const correction = fixtureBindings.get(binding.name);
      if (!correction) return binding;
      check(binding.initializerAstSha256 === correction.baselineHash, 'changed-source-binding');
      return { ...binding, initializerAstSha256: correction.currentHash };
    }),
  );
  return { universe, activeFixture };
}
function evaluateUniverseValue(node, env = {}) {
  switch (node.type) {
    case 'Literal':
      if (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value)) return node.value;
      break;
    case 'Identifier':
      if (Object.hasOwn(env, node.name)) return env[node.name];
      break;
    case 'ArrayExpression':
      if (node.elements.every((item) => item && item.type !== 'SpreadElement'))
        return node.elements.map((item) => evaluateUniverseValue(item, env));
      break;
    case 'UnaryExpression':
      if (['+', '-'].includes(node.operator)) {
        const value = evaluateUniverseValue(node.argument, env);
        check(typeof value === 'number' && Number.isFinite(value), 'unresolved-case-universe');
        return node.operator === '-' ? -value : +value;
      }
      break;
    case 'ObjectExpression':
      return evaluateUniverseObject(node, env, evaluateUniverseValue);
    case 'BinaryExpression':
      if (node.operator === '+') return evaluateUniverseValue(node.left, env) + evaluateUniverseValue(node.right, env);
      break;
    case 'TemplateLiteral':
      return evaluateUniverseTemplate(node, env, evaluateUniverseValue);
    default:
      break;
  }
  fail('unresolved-case-universe');
}
function validateStaticRegistrationContext(old, oldModel) {
  if (old.loops.length) {
    const registrations = new Map(oldModel.registrations.map((row) => [row.node, row]));
    function staticRegistrationContext(node) {
      if (registrations.has(node)) {
        const row = registrations.get(node);
        check(
          node.arguments.length === 2 &&
            node.arguments[1] === row.callback &&
            row.callback.params.every((param) => param.type === 'Identifier') &&
            !row.callback.generator,
          'dynamic-registration-context-unsupported',
        );
        staticRegistrationContext(node.arguments[0]);
        return;
      }
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
      const fixedUtc =
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object?.name === 'Date' &&
        node.callee.property.name === 'UTC' &&
        node.arguments.every(
          (item) => item.type === 'Literal' && typeof item.value === 'number' && Number.isFinite(item.value),
        );
      const siblingLoop =
        node.type === 'ForOfStatement' &&
        !old.loops.includes(node) &&
        oldModel.ast.body.includes(node) &&
        node.left?.type === 'VariableDeclaration' &&
        node.left.kind === 'const' &&
        node.left.declarations.length === 1 &&
        node.left.declarations[0].id.type === 'Identifier' &&
        node.right?.type === 'ArrayExpression' &&
        node.right.elements.length > 0 &&
        node.right.elements.every(
          (item) => item?.type === 'Literal' && ['string', 'boolean', 'number'].includes(typeof item.value),
        ) &&
        node.body?.type === 'BlockStatement' &&
        node.body.body.length === 1 &&
        node.body.body[0]?.type === 'ExpressionStatement' &&
        registrations.has(node.body.body[0].expression);
      check(
        ![
          'AssignmentExpression',
          'UpdateExpression',
          ...(fixedUtc ? [] : ['CallExpression']),
          'NewExpression',
          'AwaitExpression',
          'YieldExpression',
          'IfStatement',
          'SwitchStatement',
          'BreakStatement',
          'ContinueStatement',
          'ThrowStatement',
          'ReturnStatement',
          'TryStatement',
          'LogicalExpression',
          'ConditionalExpression',
          'ForStatement',
          'ForInStatement',
          'WhileStatement',
          'DoWhileStatement',
        ].includes(node.type) &&
          !(node.type === 'ForOfStatement' && !old.loops.includes(node) && !siblingLoop) &&
          !(node.type === 'Identifier' && ['Array', 'Symbol', 'Reflect', 'Object'].includes(node.name)) &&
          !(
            node.type === 'MemberExpression' &&
            ['prototype', '__proto__'].includes(node.computed ? node.property.value : node.property.name)
          ),
        'dynamic-registration-context-unsupported',
      );
      childNodes(node).forEach(staticRegistrationContext);
    }
    staticRegistrationContext(oldModel.ast);
  }
}
function expandUniverseEnvironments(old, oldModel, newModel, fixtureBindings) {
  let environments = [{}],
    currentEnvironments = [{}];
  for (const loop of old.loops) {
    check(
      loop.type === 'ForOfStatement' &&
        loop.left.type === 'VariableDeclaration' &&
        loop.left.kind === 'const' &&
        loop.left.declarations.length === 1 &&
        (loop.left.declarations[0].id.type === 'Identifier' ||
          (loop.left.declarations[0].id.type === 'ArrayPattern' &&
            loop.left.declarations[0].id.elements.every((item) => item?.type === 'Identifier'))),
      'unresolved-case-universe',
    );
    let expression = loop.right;
    if (expression.type === 'Identifier') {
      const name = expression.name;
      const matches = oldModel.ast.body
        .filter((item) => item.type === 'VariableDeclaration' && item.kind === 'const')
        .flatMap((item) => item.declarations)
        .filter((item) => item.id.type === 'Identifier' && item.id.name === name);
      check(matches.length === 1, 'unresolved-case-universe');
      let references = 0;
      const registrations = new Set(oldModel.registrations.map((row) => row.node));
      function countReferences(node) {
        if (registrations.has(node)) {
          countReferences(node.arguments[0]);
          return;
        }
        if (node.type === 'Identifier' && node.name === name) references++;
        childNodes(node).forEach(countReferences);
      }
      countReferences(oldModel.ast);
      // Only the const declarator and this loop's iterable may reference the array.
      check(references === 2, 'mutable-or-shared-case-source');
      expression = matches[0].init;
    }
    const values = evaluateUniverseValue(expression);
    check(Array.isArray(values), 'unresolved-case-universe');
    const sourceName = loop.right.type === 'Identifier' ? loop.right.name : null;
    const correction = fixtureBindings.get(sourceName);
    const currentDeclaration = correction
      ? newModel.declarations.filter((item) => item.name === sourceName && item.ownerTitle === null)
      : [];
    check(!correction || currentDeclaration.length === 1, 'changed-source-binding');
    const currentValues = correction ? evaluateUniverseValue(currentDeclaration[0].initializer) : values;
    check(Array.isArray(currentValues) && currentValues.length === values.length, 'corrected-case-count-mismatch');
    const binding = loop.left.declarations[0].id;
    const bind = (environments, values) =>
      environments.flatMap((env) =>
        values.map((value) => {
          if (binding.type === 'Identifier') return { ...env, [binding.name]: value };
          check(Array.isArray(value) && value.length === binding.elements.length, 'case-tuple-arity-mismatch');
          const names = binding.elements.map((item) => item.name);
          check(new Set(names).size === names.length, 'ambiguous-case-binding');
          return { ...env, ...Object.fromEntries(names.map((name, index) => [name, value[index]])) };
        }),
      );
    environments = bind(environments, values);
    currentEnvironments = bind(currentEnvironments, currentValues);
  }
  return { environments, currentEnvironments };
}
function verifyUniverse(old, current, spec, oldModel, newModel, fixtureBindings = new Map(), verifiedCaseBody = null) {
  const { universe, activeFixture } = validateUniverseContext(
    old,
    current,
    spec,
    oldModel,
    newModel,
    fixtureBindings,
    verifiedCaseBody,
  );
  validateStaticRegistrationContext(old, oldModel);
  const { environments, currentEnvironments } = expandUniverseEnvironments(old, oldModel, newModel, fixtureBindings);
  check(environments.length === universe.count, 'declared-case-count-mismatch');
  if (activeFixture)
    check(
      Array.isArray(universe.currentCaseBindings) &&
        jsonHash(universe.currentCaseBindings) === jsonHash(currentEnvironments) &&
        universe.currentCaseBindingsSha256 === jsonHash(currentEnvironments),
      'corrected-case-bindings-mismatch',
    );
  if (old.loops.length)
    check(
      Array.isArray(universe.caseBindings) && jsonHash(universe.caseBindings) === jsonHash(environments),
      'case-bindings-do-not-match',
    );
  const titles = environments.map((env) => evaluateUniverseValue(old.node.arguments[0], env));
  if (activeFixture)
    check(
      jsonHash(titles) ===
        jsonHash(currentEnvironments.map((env) => evaluateUniverseValue(current.node.arguments[0], env))),
      'corrected-case-title-mismatch',
    );
  check(
    titles.every((title) => typeof title === 'string'),
    'unresolved-case-universe',
  );
  check(
    universe.cases.every((item, index) =>
      typeof item === 'string'
        ? item === titles[index]
        : item && item.title === titles[index] && item.baselineId === old.id,
    ),
    'case-identities-do-not-match',
  );
}
function verifyProtectedKinds(oldModel, currentModel) {
  for (const kind of ['parity', 'security'])
    if (oldModel.tags.fileKinds?.includes(kind))
      check(currentModel.tags.fileKinds?.includes(kind), 'protected-kind-lost');
  const inherited = (row, model) => {
    const kinds = new Set(model.tags.fileKinds ?? []);
    for (let item = row; item; item = item.parent) for (const kind of item.kinds) kinds.add(kind);
    return kinds;
  };
  for (const old of oldModel.registrations) {
    const protectedKinds = [...inherited(old, oldModel)].filter((kind) => ['parity', 'security'].includes(kind));
    if (!protectedKinds.length) continue;
    const matches = currentModel.registrations.filter(
      (item) =>
        item.titleExpressionSha256 === old.titleExpressionSha256 &&
        item.parent?.titleExpressionSha256 === old.parent?.titleExpressionSha256,
    );
    check(matches.length === 1, 'protected-registration-ambiguous');
    const currentKinds = inherited(matches[0], currentModel);
    check(
      protectedKinds.every((kind) => currentKinds.has(kind)),
      'protected-kind-lost',
    );
  }
}
function verifyTestRegistrations(model, routing = null) {
  const bindings = new Set();
  for (const node of model.ast.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'node:test') continue;
    for (const specifier of node.specifiers) {
      check(
        specifier.type !== 'ImportNamespaceSpecifier' &&
          (specifier.type === 'ImportDefaultSpecifier' ||
            ['test', 'it'].includes(specifier.imported.name) ||
            (routing?.completeHookCoverage && ['describe', 'before', 'after'].includes(specifier.imported.name))),
        'unsupported-test-hook-or-registration',
      );
      bindings.add(specifier.local.name);
    }
  }
  function visit(node, parent) {
    if (node.type === 'ImportDeclaration') return;
    if (
      node.type === 'Identifier' &&
      bindings.has(node.name) &&
      !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
    )
      check(parent?.type === 'CallExpression' && parent.callee === node, 'unsupported-test-hook-or-registration');
    childNodes(node).forEach((child) => visit(child, node));
  }
  visit(model.ast);
}
function verifyAssertionBindings(model) {
  const names = new Set(
    model.ast.body
      .filter(
        (node) =>
          node.type === 'ImportDeclaration' && ['node:assert', 'node:assert/strict'].includes(node.source.value),
      )
      .flatMap((node) => node.specifiers.map((item) => item.local.name)),
  );
  function visit(node, parent, grandparent) {
    if (node.type === 'ImportDeclaration') return;
    if (node.type === 'Identifier' && names.has(node.name)) {
      const direct = parent?.type === 'CallExpression' && parent.callee === node;
      const member =
        parent?.type === 'MemberExpression' &&
        !parent.computed &&
        parent.object === node &&
        grandparent?.type === 'CallExpression' &&
        grandparent.callee === parent;
      check(direct || member, 'unsafe-assertion-binding');
    }
    childNodes(node).forEach((child) => visit(child, node, parent));
  }
  visit(model.ast);
}
function literalCaseValue(node) {
  if (node.type === 'Literal' && (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value)))
    return node.value;
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) {
    const value = literalCaseValue(node.argument);
    check(typeof value === 'number' && Number.isFinite(value), 'unsupported-assertion-loop');
    return node.operator === '-' ? -value : +value;
  }
  if (node.type === 'ArrayExpression' && node.elements.every((item) => item && item.type !== 'SpreadElement'))
    return node.elements.map(literalCaseValue);
  if (node.type === 'ObjectExpression') {
    const pairs = node.properties.map((item) => {
      check(
        item.type === 'Property' &&
          item.kind === 'init' &&
          !item.computed &&
          !item.method &&
          !item.shorthand &&
          (item.key.type === 'Identifier' || (item.key.type === 'Literal' && typeof item.key.value === 'string')),
        'unsupported-assertion-loop',
      );
      const key = item.key.type === 'Identifier' ? item.key.name : item.key.value;
      check(!['__proto__', 'constructor', 'prototype'].includes(key), 'unsupported-assertion-loop');
      return [key, literalCaseValue(item.value)];
    });
    check(new Set(pairs.map(([key]) => key)).size === pairs.length, 'unsupported-assertion-loop');
    return Object.fromEntries(pairs);
  }
  fail('unsupported-assertion-loop');
}
function verifyInternalLoopModule(model) {
  const registrations = new Set(model.registrations.map((row) => row.node));
  function visit(node) {
    if (
      node.type === 'ImportDeclaration' ||
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
    )
      return;
    if (registrations.has(node)) {
      const row = model.registrations.find((item) => item.node === node);
      check(
        node.arguments.length === 2 && node.arguments[1] === row.callback && node.arguments[0].type === 'Literal',
        'unsupported-assertion-loop',
      );
      return;
    }
    const fixedUtc =
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.object?.name === 'Date' &&
      node.callee.property.name === 'UTC' &&
      node.arguments.every((item) => item.type === 'Literal' && typeof item.value === 'number');
    check(
      ![
        'AssignmentExpression',
        'UpdateExpression',
        'NewExpression',
        'AwaitExpression',
        'YieldExpression',
        'IfStatement',
        'SwitchStatement',
        'BreakStatement',
        'ContinueStatement',
        'ThrowStatement',
        'ReturnStatement',
        'TryStatement',
        'LogicalExpression',
        'ConditionalExpression',
        'ForStatement',
        'ForOfStatement',
        'ForInStatement',
        'WhileStatement',
        'DoWhileStatement',
      ].includes(node.type) &&
        (node.type !== 'CallExpression' || fixedUtc) &&
        !(node.type === 'Identifier' && ['Array', 'Symbol', 'Reflect', 'Object'].includes(node.name)) &&
        !(
          node.type === 'MemberExpression' &&
          ['prototype', '__proto__'].includes(node.computed ? node.property.value : node.property.name)
        ),
      'unsupported-assertion-loop',
    );
    childNodes(node).forEach(visit);
  }
  visit(model.ast);
}
function verifyAssertionLoopFacts(mapping, outerCount, innerCount, factIds) {
  const facts = mapping.caseFacts;
  check(Array.isArray(facts) && facts.length === outerCount * innerCount, 'assertion-loop-facts-required');
  const pairs = new Set();
  for (const fact of facts) {
    check(
      Number.isInteger(fact.outerCaseIndex) &&
        fact.outerCaseIndex >= 0 &&
        fact.outerCaseIndex < outerCount &&
        Number.isInteger(fact.innerCaseIndex) &&
        fact.innerCaseIndex >= 0 &&
        fact.innerCaseIndex < innerCount &&
        Array.isArray(fact.factIds) &&
        fact.factIds.length &&
        fact.factIds.every((id) => factIds.has(id)),
      'assertion-loop-facts-required',
    );
    pairs.add(`${fact.outerCaseIndex}:${fact.innerCaseIndex}`);
  }
  check(pairs.size === facts.length, 'assertion-loop-facts-required');
}
function assertionLoopNames(binding) {
  if (binding.type === 'Identifier') return [binding.name];
  if (binding.type === 'ArrayPattern' && binding.elements.every((item) => item?.type === 'Identifier'))
    return binding.elements.map((item) => item.name);
  return [];
}
function verifyAssertionLoops(row, spec, factIds, routingLoops = []) {
  const mappings = spec.assertionLoops ?? [];
  check(Array.isArray(mappings), 'invalid-assertion-loop-map');
  const result = new Map(),
    used = new Set();
  for (const mapping of mappings) {
    check(
      SHA.test(mapping.assertionSha256) && SHA.test(mapping.loopAstSha256) && !used.has(mapping.assertionSha256),
      'invalid-assertion-loop-map',
    );
    used.add(mapping.assertionSha256);
    const assertions = row.assertions.filter((item) => item.sha256 === mapping.assertionSha256);
    check(assertions.length === 1, 'ambiguous-assertion-loop');
    const target = assertions[0].node;
    const candidates =
      row.callback.body.type === 'BlockStatement'
        ? row.callback.body.body.filter(
            (node) =>
              node.type === 'ForOfStatement' &&
              (node.body.type === 'BlockStatement' ? node.body.body : [node.body]).some(
                (statement) =>
                  statement.type === 'ExpressionStatement' &&
                  (statement.expression === target ||
                    (statement.expression.type === 'AwaitExpression' && statement.expression.argument === target)),
              ),
          )
        : [];
    check(candidates.length === 1, 'unsupported-assertion-loop');
    const loop = candidates[0];
    check(
      parityAstHash(loop) === mapping.loopAstSha256 &&
        loop.left.type === 'VariableDeclaration' &&
        loop.left.kind === 'const' &&
        loop.left.declarations.length === 1 &&
        loop.right.type === 'ArrayExpression',
      'unsupported-assertion-loop',
    );
    const certified = routingLoops.some(
      (item) =>
        item.loopAstSha256 === mapping.loopAstSha256 && item.assertionAstSha256.includes(mapping.assertionSha256),
    );
    check(
      certified ||
        ((loop.body.type === 'BlockStatement' ? loop.body.body : [loop.body]).length > 0 &&
          (loop.body.type === 'BlockStatement' ? loop.body.body : [loop.body]).every((statement) => {
            if (statement.type !== 'ExpressionStatement') return false;
            const expression =
              statement.expression.type === 'AwaitExpression' ? statement.expression.argument : statement.expression;
            return row.assertions.some((item) => item.node === expression);
          })),
      'unsupported-assertion-loop',
    );
    const binding = loop.left.declarations[0].id,
      values = literalCaseValue(loop.right);
    check(values.length > 0, 'unsupported-assertion-loop');
    const names = assertionLoopNames(binding);
    check(names.length && new Set(names).size === names.length, 'unsupported-assertion-loop');
    const cases = values.map((value) => {
      const tuple = binding.type === 'Identifier' ? [value] : value;
      check(Array.isArray(tuple) && tuple.length === names.length, 'unsupported-assertion-loop');
      return Object.fromEntries(names.map((name, index) => [name, tuple[index]]));
    });
    check(
      Array.isArray(mapping.caseBindings) &&
        jsonHash(mapping.caseBindings) === jsonHash(cases) &&
        mapping.caseBindingsSha256 === jsonHash(cases),
      'assertion-loop-cases-mismatch',
    );
    verifyAssertionLoopFacts(mapping, spec.caseUniverse.count, cases.length, factIds);
    result.set(target, loop);
  }
  return result;
}
function verifyExecution(
  row,
  assertions,
  recognizedIdentifiers = new Set(),
  concise = false,
  assertionLoops = new Map(),
) {
  function checkContext(node, parent, grandparent, greatGrandparent) {
    if (recognizedIdentifiers.has(node)) return;
    if (node.type === 'Identifier' && node.name === row.callback.params[0]?.name) {
      check(
        parent?.type === 'MemberExpression' &&
          parent.object === node &&
          !parent.computed &&
          !['skip', 'todo'].includes(parent.property.name),
        'unsupported-test-context-use',
      );
      if (parent.property.name === 'after') {
        const callback = grandparent?.arguments?.[0];
        const restore = callback?.body?.body?.[0]?.expression;
        check(
          grandparent?.type === 'CallExpression' &&
            grandparent.callee === parent &&
            grandparent.arguments.length === 1 &&
            callback?.type === 'ArrowFunctionExpression' &&
            callback.params.length === 0 &&
            callback.body.type === 'BlockStatement' &&
            callback.body.body.length === 1 &&
            restore?.type === 'AssignmentExpression' &&
            restore.operator === '=' &&
            restore.left?.type === 'MemberExpression' &&
            !restore.left.computed &&
            restore.left.object?.name === 'globalThis' &&
            restore.left.property.name === 'fetch' &&
            restore.right.type === 'Identifier',
          'unsupported-test-hook-or-registration',
        );
      } else check(['test', 'assert'].includes(parent.property.name), 'unsupported-test-hook-or-registration');
      if (parent.property.name === 'assert')
        check(
          grandparent?.type === 'MemberExpression' &&
            !grandparent.computed &&
            grandparent.object === parent &&
            greatGrandparent?.type === 'CallExpression' &&
            greatGrandparent.callee === grandparent,
          'unsafe-assertion-binding',
        );
    }
    childNodes(node).forEach((child) => checkContext(child, node, parent, grandparent));
  }
  checkContext(row.callback.body);
  if (concise) {
    let expression = row.callback.body;
    if (expression.type === 'BlockStatement') {
      const body = expression.body;
      check(
        body.length === 2 &&
          body[0].type === 'ExpressionStatement' &&
          body[0].expression.type === 'CallExpression' &&
          [IMPORT, REGION_IMPORT].includes(body[0].expression.callee.name) &&
          body[1].type === 'ReturnStatement' &&
          body[1].argument,
        'changed-concise-callback',
      );
      expression = body[1].argument;
    }
    if (expression.type === 'AwaitExpression') expression = expression.argument;
    check(assertions.length === 1 && assertions[0] === expression, 'conditional-or-nested-assertion');
    if (row.parent) verifyParentExecution(row.parent, row.node, recognizedIdentifiers);
    return;
  }
  function prefixBefore(targetNodes) {
    const positions = targetNodes.map((target) =>
      assertionLoops.has(target)
        ? row.callback.body.body.indexOf(assertionLoops.get(target))
        : row.callback.body.body.findIndex(
            (statement) =>
              statement.type === 'ExpressionStatement' &&
              (statement.expression === target ||
                (statement.expression.type === 'AwaitExpression' && statement.expression.argument === target)),
          ),
    );
    check(
      positions.every((position) => position >= 0),
      'conditional-or-nested-assertion',
    );
    targetNodes.forEach((target, index) => {
      const callee = target.callee;
      const imported = row.assertions.find((item) => item.node === target)?.libraryBindings;
      let method = null;
      if (callee?.type === 'MemberExpression' && !callee.computed) method = callee.property.name;
      else if (callee?.type === 'Identifier') method = imported?.get(callee.name)?.name;
      if (['rejects', 'doesNotReject'].includes(method)) {
        const outer = row.callback.body.body[positions[index]];
        const statement = assertionLoops.has(target)
          ? outer.body.body.find(
              (item) =>
                item.type === 'ExpressionStatement' &&
                (item.expression === target ||
                  (item.expression.type === 'AwaitExpression' && item.expression.argument === target)),
            )
          : outer;
        check(statement?.expression.type === 'AwaitExpression', 'unawaited-async-assertion');
      }
    });
    const end = Math.max(...positions);
    function scan(node) {
      if ([...assertionLoops.values()].includes(node)) return;
      if (
        assertionLoops.size &&
        node.type === 'Identifier' &&
        ['Array', 'Symbol', 'Reflect', 'Object'].includes(node.name)
      )
        fail('unsupported-assertion-loop');
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
      check(
        ![
          'ReturnStatement',
          'IfStatement',
          'SwitchStatement',
          'TryStatement',
          'ForStatement',
          'ForOfStatement',
          'ForInStatement',
          'WhileStatement',
          'DoWhileStatement',
          'BreakStatement',
          'ContinueStatement',
          'ThrowStatement',
        ].includes(node.type),
        'conditional-assertion-execution',
      );
      childNodes(node).forEach(scan);
    }
    row.callback.body.body.slice(0, end + 1).forEach(scan);
  }
  if (assertions.length) prefixBefore(assertions);
  if (row.parent) verifyParentExecution(row.parent, row.node, recognizedIdentifiers);
}
function verifyParentExecution(parent, child, recognizedIdentifiers) {
  // The parent must reach its awaited subtest; the child is treated as the target statement.
  verifyExecution(parent, [child], recognizedIdentifiers);
}
function verifyCaseFacts(spec, factIds, assertions) {
  if (spec.caseUniverse.count === 1) return;
  const mapping = spec.caseFacts;
  check(
    Array.isArray(mapping) && mapping.length === spec.caseUniverse.count * assertions.length,
    'case-fact-bindings-required',
  );
  const pairs = new Set();
  for (const item of mapping) {
    check(
      Number.isInteger(item.caseIndex) &&
        item.caseIndex >= 0 &&
        item.caseIndex < spec.caseUniverse.count &&
        Number.isInteger(item.assertionIndex) &&
        item.assertionIndex >= 0 &&
        item.assertionIndex < assertions.length &&
        Array.isArray(item.factIds) &&
        item.factIds.length &&
        item.factIds.every((id) => factIds.has(id)),
      'case-fact-bindings-required',
    );
    pairs.add(`${item.caseIndex}:${item.assertionIndex}`);
  }
  check(pairs.size === mapping.length, 'case-fact-bindings-required');
}
function regionStatements(row, region, allowReturn = false) {
  check(Array.isArray(region.assertions) && region.assertions.length, 'region-assertions-required');
  const hashes = region.assertions.map((item) => item.sha256);
  const expression = (statement) => {
    const value = statement.type === 'ReturnStatement' && allowReturn ? statement.argument : statement.expression;
    return value?.type === 'AwaitExpression' ? value.argument : value;
  };
  check(
    hashes.every((hash) => SHA.test(hash)),
    'invalid-region-assertion',
  );
  const matches = [];
  const body =
    row.callback.body.type === 'BlockStatement'
      ? row.callback.body.body
      : [
          {
            type: 'ExpressionStatement',
            expression: row.callback.body,
            range: row.callback.body.range,
            loc: row.callback.body.loc,
          },
        ];
  for (let i = 0; i <= body.length - hashes.length; i++) {
    const statements = body.slice(i, i + hashes.length);
    if (
      statements.every(
        (statement, n) =>
          (statement.type === 'ExpressionStatement' || (allowReturn && statement.type === 'ReturnStatement')) &&
          row.assertions.some(
            (assertion) => assertion.node === expression(statement) && assertion.sha256 === hashes[n],
          ),
      )
    )
      matches.push(statements);
  }
  check(matches.length === 1, matches.length ? 'ambiguous-region' : 'missing-contiguous-region');
  const statements = matches[0];
  function safeNested(node) {
    check(
      node.type !== 'ImportExpression' && !(node.type === 'Identifier' && ['eval', 'Function'].includes(node.name)),
      'nested-control-region-unsupported',
    );
    check(!row.assertions.some((item) => item.node === node), 'nested-assertion-region-unsupported');
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const registration =
        (callee.type === 'Identifier' && ['test', 'it'].includes(row.testBindings.get(callee.name))) ||
        (callee.type === 'MemberExpression' &&
          !callee.computed &&
          ['test', 'skip', 'todo'].includes(callee.property.name));
      check(
        !registration && !(callee.type === 'Identifier' && ['eval', 'Function'].includes(callee.name)),
        'nested-control-region-unsupported',
      );
    }
    childNodes(node).forEach(safeNested);
  }
  function safe(node) {
    if (['FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      check(!node.generator, 'unsafe-region-expression');
      safeNested(node);
      return;
    }
    check(
      !['YieldExpression', 'FunctionDeclaration', 'ClassExpression', 'ClassDeclaration', 'MetaProperty'].includes(
        node.type,
      ) &&
        !(node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval') &&
        (node.type !== 'AwaitExpression' || row.callback.async),
      'unsafe-region-expression',
    );
    for (const child of childNodes(node)) safe(child);
  }
  statements.forEach(safe);
  return statements;
}
function verifyPartial(oldModel, currentModel, spec, factIds, moduleDelta, generated = {}) {
  const replacements = moduleDelta?.replacements ?? new Map();
  const verifiedCaseBody = moduleDelta?.verifiedCaseBody;
  const old = oldModel.registrations.find((item) => item.id === spec.baselineId);
  check(old && old.titleExpressionSha256 === spec.titleExpressionSha256, 'stale-baseline-id');
  const current = registration(currentModel, spec);
  check(Array.isArray(spec.regions) && spec.regions.length && !spec.assertions, 'partial-regions-required');
  const originalGuards = new Set(old.assertions.filter(isHashGuard).map((item) => item.sha256));
  if (!verifiedCaseBody)
    check(
      parityAstHash(strippedBody(old, originalGuards, new Map(), old.callback.expression)) ===
        parityAstHash(strippedBody(current, originalGuards, replacements, old.callback.expression)),
      'changed-original-body',
    );
  verifyUniverse(old, current, spec, oldModel, currentModel, moduleDelta?.fixtureBindings, verifiedCaseBody);
  if (spec.caseSelection) {
    const loop = old.loops[0],
      binding = loop?.left?.declarations?.[0]?.id,
      names = binding?.type === 'Identifier' ? [binding.name] : binding?.elements?.map((item) => item?.name);
    const selected = spec.caseSelection.selected;
    check(
      old.loops.length === 1 &&
        loop.type === 'ForOfStatement' &&
        loop.right.type === 'Identifier' &&
        spec.caseUniverse.sourceBindings.length === 1 &&
        spec.caseUniverse.sourceBindings[0].name === loop.right.name &&
        !old.callback.async &&
        !current.callback.async &&
        (old.kinds.includes('unproven') || (verifiedCaseBody && old.kinds.length === 0)) &&
        current.kinds.includes('unproven') &&
        !old.kinds.includes('parity') &&
        !current.kinds.includes('parity') &&
        old.callback.params.length === 0 &&
        current.callback.params.length === 0 &&
        old.callback.expression &&
        spec.regions.length === 1 &&
        spec.regions[0].assertions.length === 1 &&
        Array.isArray(names) &&
        names.every((name) => typeof name === 'string') &&
        new Set(names).size === names.length &&
        Array.isArray(spec.caseUniverse.caseBindings) &&
        spec.caseUniverse.caseBindings.length === spec.caseUniverse.count &&
        spec.caseUniverse.caseBindings.every((item) => jsonHash(Object.keys(item)) === jsonHash(names)) &&
        new Set(spec.caseUniverse.caseBindings.map(jsonHash)).size === spec.caseUniverse.count &&
        (!spec.caseUniverse.currentCaseBindings ||
          (moduleDelta?.fixtureBindings.has(loop.right.name) &&
            spec.caseUniverse.currentCaseBindings.length === spec.caseUniverse.count &&
            spec.caseUniverse.currentCaseBindings.every((item) => jsonHash(Object.keys(item)) === jsonHash(names)) &&
            new Set(spec.caseUniverse.currentCaseBindings.map(jsonHash)).size === spec.caseUniverse.count)) &&
        Array.isArray(selected) &&
        selected.length > 0 &&
        selected.every(
          (item, index) =>
            Number.isInteger(item.caseIndex) &&
            item.caseIndex >= 0 &&
            item.caseIndex < spec.caseUniverse.count &&
            (!index || item.caseIndex > selected[index - 1].caseIndex) &&
            Array.isArray(item.factIds) &&
            item.factIds.length &&
            item.factIds.every((id) => factIds.has(id)),
        ),
      'invalid-case-parity-selection',
    );
  } else
    verifyCaseFacts(
      spec,
      factIds,
      spec.regions.flatMap((region) => region.assertions ?? []),
    );
  const regions = spec.regions.map((region) => {
    for (const item of region.assertions ?? [])
      check(
        Array.isArray(item.factIds) && item.factIds.length && item.factIds.every((id) => factIds.has(id)),
        'assertion-fact-binding-required',
      );
    const baseline = regionStatements(old, region);
    const effective = {
      ...region,
      assertions: region.assertions.map((item) => {
        const replacement = [...replacements].find(
          ([candidate, previous]) =>
            current.assertions.some((assertion) => assertion.node === candidate) &&
            parityAstHash(previous) === item.sha256,
        );
        return replacement ? { ...item, sha256: parityAstHash(replacement[0]) } : item;
      }),
    };
    const statements = regionStatements(current, effective, Boolean(verifiedCaseBody));
    check(
      verifiedCaseBody
        ? jsonHash(baseline.map((statement) => parityAstHash(statement.expression))) ===
            jsonHash(statements.map((statement) => parityAstHash(statement.argument)))
        : jsonHash(baseline.map(parityAstHash)) ===
            jsonHash(
              statements.map((statement) =>
                parityAstHash({
                  ...statement,
                  expression: replacements.get(statement.expression) ?? statement.expression,
                }),
              ),
            ),
      'changed-original-assertion',
    );
    return { region: effective, statements };
  });
  verifyExecution(
    old,
    spec.regions.flatMap((region) =>
      regionStatements(old, region).map((statement) =>
        statement.expression.type === 'AwaitExpression' ? statement.expression.argument : statement.expression,
      ),
    ),
    generated.old?.recognizedIdentifiers,
    old.callback.expression,
  );
  if (!verifiedCaseBody)
    verifyExecution(
      current,
      regions.flatMap(({ statements }) =>
        statements.map((statement) =>
          statement.expression.type === 'AwaitExpression' ? statement.expression.argument : statement.expression,
        ),
      ),
      generated.current?.recognizedIdentifiers,
      old.callback.expression,
    );
  const positions = regions.flatMap(({ statements }) => statements.map((statement) => statement.range[0]));
  check(new Set(positions).size === positions.length, 'overlapping-regions');
  check(
    positions.every((position, index) => !index || position > positions[index - 1]),
    'regions-out-of-source-order',
  );
  return { old, current, spec, regions, partial: true, verifiedCaseBody };
}
function retainedUniverseAssertions(current, old, spec, model) {
  const hashes = spec.retainedUniverseAssertions ?? [];
  check(
    Array.isArray(hashes) && hashes.length <= 1 && hashes.every((hash) => SHA.test(hash)),
    'invalid-retained-universe-assertion',
  );
  if (!hashes.length) return new Set();
  const binding = spec.caseUniverse?.sourceBindings;
  const loop = old.loops[0];
  check(
    binding?.length === 1 &&
      old.loops.length === 1 &&
      loop.type === 'ForOfStatement' &&
      loop.right.type === 'Identifier' &&
      loop.right.name === binding[0].name &&
      loop.left.type === 'VariableDeclaration' &&
      loop.left.kind === 'const' &&
      loop.left.declarations.length === 1 &&
      loop.left.declarations[0].id.type === 'ArrayPattern' &&
      Array.isArray(spec.caseUniverse.caseBindings),
    'invalid-retained-universe-assertion',
  );
  const names = loop.left.declarations[0].id.elements.map((item) => item?.name);
  check(names.length && names.every((name) => /^[A-Za-z_$][\w$]*$/u.test(name)), 'invalid-retained-universe-assertion');
  const rows = spec.caseUniverse.caseBindings.map((row) => names.map((name) => row[name]));
  const assertion = current.assertions.find((item) => item.sha256 === hashes[0]);
  const callee = assertion?.node?.callee?.object?.name;
  check(
    assertion &&
      current.assertions.filter((item) => item.sha256 === hashes[0]).length === 1 &&
      /^[A-Za-z_$][\w$]*$/u.test(callee ?? '') &&
      /^[A-Za-z_$][\w$]*$/u.test(binding[0].name) &&
      assertion.libraryBindings.get('createHash')?.source === 'node:crypto' &&
      assertion.libraryBindings.get('createHash')?.name === 'createHash' &&
      !['createHash', 'JSON'].some((name) => assertion.declaredNames.has(name)) &&
      current.callback.params.length === 0 &&
      model.declarations.filter((item) => item.name === binding[0].name).length === 1,
    'invalid-retained-universe-assertion',
  );
  const expected = parse(
    `${callee}.equal(createHash('sha256').update(JSON.stringify(${binding[0].name})).digest('hex'), ${JSON.stringify(parityHash(JSON.stringify(rows)))});`,
    { ecmaVersion: 'latest', sourceType: 'module' },
  ).body[0].expression;
  check(parityAstHash(expected) === hashes[0], 'invalid-retained-universe-assertion');
  return new Set(hashes);
}
function retainedUniverseNodes(model, oldModel, specifications) {
  const nodes = new Set();
  for (const spec of specifications.filter((item) => item.retainedUniverseAssertions?.length)) {
    const old = oldModel.registrations.find((item) => item.id === spec.baselineId);
    check(old, 'stale-baseline-id');
    const current = registration(model, spec);
    const hashes = retainedUniverseAssertions(current, old, spec, model);
    for (const assertion of current.assertions) if (hashes.has(assertion.sha256)) nodes.add(assertion.node);
  }
  return nodes;
}
function verifyTest(oldModel, currentModel, spec, factIds, generated = {}, moduleDelta) {
  const old = oldModel.registrations.find((item) => item.id === spec.baselineId);
  check(old && old.titleExpressionSha256 === spec.titleExpressionSha256, 'stale-baseline-id');
  const current = registration(currentModel, spec);
  const retained = retainedUniverseAssertions(current, old, spec, currentModel);
  check(old.assertions.length > 0, 'recognized-original-assertions-required');
  check(
    Array.isArray(spec.assertions) && spec.assertions.length === old.assertions.length,
    'all-original-assertions-required',
  );
  const counts = (items) =>
    items.reduce((out, item) => {
      out.set(item.sha256, (out.get(item.sha256) ?? 0) + 1);
      return out;
    }, new Map());
  const wanted = counts(old.assertions),
    mapped = counts(spec.assertions);
  check(
    JSON.stringify([...wanted].sort(compareCodeUnits)) === JSON.stringify([...mapped].sort(compareCodeUnits)),
    'assertion-map-does-not-match-baseline',
  );
  for (const item of spec.assertions)
    check(
      Array.isArray(item.factIds) && item.factIds.length && item.factIds.every((id) => factIds.has(id)),
      'assertion-fact-binding-required',
    );
  const corrections = new Map(
    [...(moduleDelta?.replacements ?? new Map())]
      .filter(([currentNode]) => current.assertions.some((item) => item.node === currentNode))
      .map(([currentNode, oldNode]) => [parityAstHash(oldNode), parityAstHash(currentNode)]),
  );
  for (const [hash, count] of wanted)
    check(
      current.assertions.filter((item) => item.sha256 === (corrections.get(hash) ?? hash)).length >= count,
      'changed-original-assertion',
    );
  check(
    current.assertions.every(
      (item) =>
        wanted.has(item.sha256) ||
        [...corrections.values()].includes(item.sha256) ||
        isHashGuard(item) ||
        retained.has(item.sha256),
    ),
    'unmapped-current-assertion',
  );
  const originalGuards = new Set(old.assertions.filter(isHashGuard).map((item) => item.sha256));
  check(
    parityAstHash(strippedBody(old, originalGuards, new Map(), old.callback.expression)) ===
      parityAstHash(
        strippedBody(
          current,
          originalGuards,
          moduleDelta?.replacements ?? new Map(),
          old.callback.expression,
          retained,
        ),
      ),
    'changed-original-body',
  );
  verifyUniverse(old, current, spec, oldModel, currentModel, moduleDelta?.fixtureBindings);
  verifyCaseFacts(spec, factIds, spec.assertions);
  if (spec.assertionLoops?.length) {
    const fullyCertified = spec.assertionLoops.every((mapping) =>
      generated.routingLoops?.some(
        (item) =>
          item.loopAstSha256 === mapping.loopAstSha256 && item.assertionAstSha256.includes(mapping.assertionSha256),
      ),
    );
    if (!fullyCertified) {
      verifyInternalLoopModule(oldModel);
      verifyInternalLoopModule(currentModel);
    }
  }
  const oldLoops = verifyAssertionLoops(old, spec, factIds, generated.routingLoops),
    currentLoops = verifyAssertionLoops(current, spec, factIds, generated.routingLoops);
  verifyExecution(
    old,
    old.assertions.map((item) => item.node),
    generated.old?.recognizedIdentifiers,
    old.callback.expression,
    oldLoops,
  );
  verifyExecution(
    current,
    current.assertions.filter((item) => !isHashGuard(item)).map((item) => item.node),
    generated.current?.recognizedIdentifiers,
    old.callback.expression,
    currentLoops,
  );
  return { old, current, spec };
}
// Recognize the later, separate TypeScript tooling test without granting its
// process-launch capability to a selected SDK test or to module setup.
function analyzeSdkLateHarness(model, spec) {
  const selected = registration(model, spec);
  const harness = model.registrations.filter(
    (row) => row.title === 'SDK declaration accepts a strict TypeScript consumer with a partial client',
  );
  check(
    selected &&
      !selected.parent &&
      harness.length === 1 &&
      !harness[0].parent &&
      selected.node.range[0] < harness[0].node.range[0],
    'unsupported-sdk-harness',
  );
  const tree = model.ast,
    imports = tree.body.filter((node) => node.type === 'ImportDeclaration');
  const exactImport = (source, imported, local) => {
    const found = imports.filter((node) => node.source.value === source);
    check(
      found.length === 1 &&
        found[0].specifiers.length === 1 &&
        found[0].specifiers[0].type === 'ImportSpecifier' &&
        found[0].specifiers[0].imported.name === imported &&
        found[0].specifiers[0].local.name === local,
      'unsupported-sdk-harness',
    );
    return found[0];
  };
  const child = exactImport('node:child_process', 'execFileSync', 'execFileSync');
  const url = exactImport('node:url', 'fileURLToPath', 'fileURLToPath');
  const testImports = imports.filter((node) => node.source.value === 'node:test');
  check(
    testImports.length === 1 &&
      testImports[0].specifiers.length === 1 &&
      testImports[0].specifiers[0].type === 'ImportDefaultSpecifier' &&
      testImports[0].specifiers[0].local.name === 'test',
    'unsupported-sdk-harness',
  );
  const parents = new Map();
  function visit(node) {
    for (const childNode of childNodes(node)) {
      parents.set(childNode, node);
      visit(childNode);
    }
  }
  visit(tree);
  const scopes = analyzeScopes(tree, { ecmaVersion: 2022, sourceType: 'module' }),
    moduleScope = scopes.scopes.find((scope) => scope.type === 'module');
  for (const [name, declaration] of [
    ['execFileSync', child],
    ['fileURLToPath', url],
  ]) {
    const variable = moduleScope?.set.get(name);
    check(
      variable?.defs.length === 1 &&
        variable.defs[0].parent === declaration &&
        variable.references.length > 0 &&
        scopes.scopes.every((scope) => scope === moduleScope || !scope.set.has(name)) &&
        variable.references.every((ref) => {
          const id = ref.identifier,
            parent = parents.get(id);
          return (
            id.range[0] >= harness[0].callback.range[0] &&
            id.range[1] <= harness[0].callback.range[1] &&
            parent?.type === 'CallExpression' &&
            parent.callee === id
          );
        }),
      'unsupported-sdk-harness',
    );
  }
  const testBinding = moduleScope?.set.get('test');
  check(
    testBinding?.defs.length === 1 &&
      testBinding.references.length === model.registrations.length &&
      testBinding.references.every((ref) => {
        const call = parents.get(ref.identifier);
        return (
          call?.type === 'CallExpression' &&
          call.callee === ref.identifier &&
          call.arguments.length === 2 &&
          model.registrations.some((row) => !row.parent && row.node === call)
        );
      }) &&
      model.registrations.every((row) => !row.parent && row.callback.params.length === 0),
    'unsupported-sdk-harness',
  );
  return {
    recognizedBuiltinImports: new Set([child, url]),
    recognizedIdentifiers: new Set(),
    isolatedIdentifiers: new Set(),
    recognizedExternalInputs: new Set(),
    handledInputSources: new Set(),
    dependencies: [],
    fixtures: [],
  };
}

// Reviewers classify direct imports explicitly. Input modules and their static local closure are byte-bound.
function reviewStaticImportRoles(model, file, generated) {
  const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
  function safeBuiltin(node) {
    if (generated.recognizedBuiltinImports?.has(node)) return;
    if (!(
      node.type === 'ImportDeclaration' ||
      (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
    ))
      return;
    const source = node.source.value;
    if (!source.startsWith('node:')) {
      check(!nodeBuiltins.has(source), 'unsupported-builtin-import');
      return;
    }
    const allowed = [
      'node:test',
      'node:assert',
      'node:assert/strict',
      'node:url',
      'node:path',
      'node:buffer',
      'node:util',
      'node:fs',
      'node:fs/promises',
    ];
    if (allowed.includes(source)) return;
    check(
      source === 'node:crypto' &&
        node.type === 'ImportDeclaration' &&
        node.specifiers.length &&
        node.specifiers.every((item) => item.type === 'ImportSpecifier' && item.imported.name === 'createHash'),
      'unsupported-builtin-import',
    );
  }
  model.ast.body.forEach((node) => safeBuiltin(node));
  const direct = model.ast.body
    .filter(
      (node) =>
        (node.type === 'ImportDeclaration' ||
          (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)) &&
        !node.source.value.startsWith('node:'),
    )
    .map((node) => node.source.value);
  check(new Set(direct).size === direct.length, 'ambiguous-import-role');
  const roles = file.importRoles ?? [];
  check(
    Array.isArray(roles) &&
      roles.length === direct.length &&
      new Set(roles.map((role) => role.source)).size === roles.length &&
      direct.every((source) => roles.some((role) => role.source === source)),
    'reviewed-import-roles-required',
  );
  for (const role of roles)
    check(
      ['implementation-under-test', 'test-input'].includes(role.role) &&
        typeof role.reviewedBy === 'string' &&
        role.reviewedBy.length > 0 &&
        typeof role.reason === 'string' &&
        role.reason.trim().length >= 20,
      'reviewed-import-roles-required',
    );
  const builtinExternal = /^(?:node:)?(?:http|https|net|tls|dgram|child_process|dns|os)$/u;
  for (const item of model.ast.body)
    check(
      !(
        item.type === 'ImportDeclaration' &&
        builtinExternal.test(item.source.value) &&
        !generated.recognizedBuiltinImports?.has(item)
      ),
      'external-builtin-input-unsupported',
    );
  return { roles, safeBuiltin, builtinExternal };
}

function collectReviewedAssets(model, generated) {
  const fsBindings = new Map(),
    assets = [];
  for (const item of model.ast.body) {
    if (item.type !== 'ImportDeclaration' || !['node:fs', 'node:fs/promises'].includes(item.source.value)) continue;
    for (const specifier of item.specifiers) {
      const name = specifier.type === 'ImportSpecifier' ? specifier.imported.name : '*';
      check(['*', 'readFile', 'readFileSync'].includes(name), 'unsupported-filesystem-input');
      fsBindings.set(specifier.local.name, name);
    }
  }
  function scanAssets(node, ancestors = []) {
    if (generated.recognizedIdentifiers?.has(node)) return;
    if (fsBindings.size && node.type === 'Identifier' && node.name === 'URL') {
      const parent = ancestors.at(-1);
      check(parent?.type === 'NewExpression' && parent.callee === node, 'unsupported-filesystem-input');
    }
    if (node.type === 'Identifier' && fsBindings.has(node.name)) {
      const parent = ancestors.at(-1),
        grandparent = ancestors.at(-2);
      if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(parent?.type)) return;
      let call;
      if (
        fsBindings.get(node.name) === '*' &&
        parent?.type === 'MemberExpression' &&
        parent.object === node &&
        !parent.computed &&
        ['readFile', 'readFileSync'].includes(parent.property.name) &&
        grandparent?.type === 'CallExpression' &&
        grandparent.callee === parent
      )
        call = grandparent;
      else if (fsBindings.get(node.name) !== '*' && parent?.type === 'CallExpression' && parent.callee === node)
        call = parent;
      check(call, 'unsupported-filesystem-input');
      const url = call.arguments[0],
        meta = url?.arguments?.[1];
      check(
        url?.type === 'NewExpression' &&
          url.callee.type === 'Identifier' &&
          url.callee.name === 'URL' &&
          !model.declarations.some((item) => item.name === 'URL') &&
          url.arguments.length === 2 &&
          typeof url.arguments[0]?.value === 'string' &&
          meta?.type === 'MemberExpression' &&
          !meta.computed &&
          meta.property.name === 'url' &&
          meta.object.type === 'MetaProperty' &&
          meta.object.meta.name === 'import' &&
          meta.object.property.name === 'meta',
        'unsupported-filesystem-input',
      );
      assets.push(url.arguments[0].value);
    }
    childNodes(node).forEach((child) => scanAssets(child, [...ancestors, node]));
  }
  scanAssets(model.ast);
  return assets;
}

function collectNetworkRestorations(row, statements, index, externalKind) {
  const originals = new Set(),
    restorations = new Set();
  for (const statement of statements.slice(0, index)) {
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        check(declaration.id.type === 'Identifier' && declaration.init, 'unknown-runtime-input-producer');
        if (externalKind(declaration.init) === 'network') originals.add(declaration.id.name);
        else
          check(
            ['Literal', 'ArrayExpression', 'ObjectExpression'].includes(declaration.init.type) &&
              childNodes(declaration.init).every((item) => item.type === 'Literal'),
            'unknown-runtime-input-producer',
          );
      }
      continue;
    }
    const call = statement.type === 'ExpressionStatement' && statement.expression;
    const callback = call?.arguments?.[0];
    const restore = callback?.body?.body?.[0]?.expression;
    check(
      call?.type === 'CallExpression' &&
        call.callee.type === 'MemberExpression' &&
        !call.callee.computed &&
        call.callee.object.name === row.callback.params[0]?.name &&
        call.callee.property.name === 'after' &&
        call.arguments.length === 1 &&
        callback?.type === 'ArrowFunctionExpression' &&
        callback.body.type === 'BlockStatement' &&
        callback.body.body.length === 1 &&
        restore?.type === 'AssignmentExpression' &&
        restore.operator === '=' &&
        externalKind(restore.left) === 'network' &&
        restore.right.type === 'Identifier' &&
        originals.has(restore.right.name),
      'unknown-runtime-input-producer',
    );
    restorations.add(restore);
  }
  return { originals, restorations };
}

function verifyNetworkProducer(row, producers, externalKind) {
  const statements = row.callback.body.body;
  const index = statements.findIndex(
    (statement) =>
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'AssignmentExpression' &&
      externalKind(statement.expression.left) === 'network' &&
      producers.has(parityAstHash(statement.expression.right)),
  );
  check(index >= 0, 'unknown-runtime-input-producer');
  const { originals, restorations } = collectNetworkRestorations(row, statements, index, externalKind);
  for (const name of originals) {
    let uses = 0;
    function countUses(node) {
      if (node.type === 'Identifier' && node.name === name) uses++;
      childNodes(node).forEach(countUses);
    }
    countUses(row.callback.body);
    check(uses === 2, 'unknown-runtime-input-producer');
  }
  function checkAssignments(node) {
    if (node.type === 'AssignmentExpression' && externalKind(node.left) === 'network')
      check(node === statements[index].expression || restorations.has(node), 'unknown-runtime-input-producer');
    childNodes(node).forEach(checkAssignments);
  }
  checkAssignments(row.callback.body);
}

function collectRuntimeProducers(row, producers, externalKind) {
  for (const statement of row.callback.body.type === 'BlockStatement' ? row.callback.body.body : []) {
    const assignment = statement.type === 'ExpressionStatement' && statement.expression;
    if (assignment?.type !== 'AssignmentExpression' || assignment.operator !== '=') continue;
    const kind = externalKind(assignment.left);
    if (
      kind &&
      ((['network', 'clock'].includes(kind) &&
        ['FunctionExpression', 'ArrowFunctionExpression'].includes(assignment.right.type)) ||
        (kind === 'environment' && assignment.right.type === 'ObjectExpression'))
    )
      producers.set(parityAstHash(assignment.right), kind);
  }
}

function collectSelectedRuntimeInputs(selected, classify, externalKind) {
  const expected = [];
  for (const { old: row } of selected) {
    const kinds = new Set(),
      producers = new Map();
    classify(row.callback.body, null, kinds, true);
    collectRuntimeProducers(row, producers, externalKind);
    for (const kind of kinds) {
      if (kind === 'network') verifyNetworkProducer(row, producers, externalKind);
      else fail('unknown-runtime-input-producer');
      expected.push({ baselineId: row.id, kind, producers });
    }
  }
  return expected;
}

function reviewRuntimeInputs(model, file, selected, generated) {
  const property = (node) => {
    if (node?.type !== 'MemberExpression') return null;
    if (!node.computed) return node.property.name;
    return node.property.type === 'Literal' ? node.property.value : null;
  };
  const externalKind = (node) => {
    if (node?.type === 'MemberExpression' && node.object?.name === 'globalThis' && property(node) === 'fetch')
      return 'network';
    if (node?.type === 'Identifier' && node.name === 'fetch') return 'network';
    if (node?.type === 'Identifier' && node.name === 'crypto') return 'random';
    if (node?.type === 'MemberExpression' && node.object?.name === 'process' && property(node) === 'env')
      return 'environment';
    if (node?.type === 'MemberExpression' && node.object?.name === 'Date' && property(node) === 'now') return 'clock';
    if (node?.type === 'MemberExpression' && node.object?.name === 'Math' && property(node) === 'random')
      return 'random';
    if (
      ['NewExpression', 'CallExpression'].includes(node?.type) &&
      node.callee?.name === 'Date' &&
      !node.arguments.length
    )
      return 'clock';
    return null;
  };
  function classify(node, parent, kinds, skipRegistrations) {
    if (skipRegistrations && registrations.has(node)) return;
    if (generated.recognizedExternalInputs?.has(node)) return;
    if (node.type === 'Identifier' && ['globalThis', 'process', 'Date'].includes(node.name)) {
      const allowedMember =
        parent?.type === 'MemberExpression' &&
        parent.object === node &&
        ((node.name === 'globalThis' && property(parent) === 'fetch') ||
          (node.name === 'process' && property(parent) === 'env') ||
          (node.name === 'Date' && ['now', 'UTC', 'parse'].includes(property(parent))));
      const fixedDate =
        node.name === 'Date' &&
        parent?.type === 'NewExpression' &&
        parent.callee === node &&
        parent.arguments.length > 0;
      check(allowedMember || fixedDate, 'unknown-runtime-input-producer');
    }
    if (node.type === 'Identifier' && ['window', 'self'].includes(node.name)) fail('unknown-runtime-input-producer');
    const kind = externalKind(node);
    // The property identifier of globalThis.fetch is not a separate bare fetch use.
    if (
      kind &&
      !(
        node.type === 'Identifier' &&
        parent?.type === 'MemberExpression' &&
        parent.property === node &&
        !parent.computed
      )
    )
      kinds.add(kind);
    childNodes(node).forEach((child) => classify(child, node, kinds, skipRegistrations));
  }
  const registrations = new Set(model.registrations.map((row) => row.node));
  const moduleKinds = new Set();
  classify(model.ast, null, moduleKinds, true);
  check(moduleKinds.size === 0, 'module-runtime-input-unsupported');
  const expected = collectSelectedRuntimeInputs(selected, classify, externalKind);
  const runtimeInputs = file.runtimeInputs ?? [];
  check(
    Array.isArray(runtimeInputs) &&
      runtimeInputs.length === expected.length &&
      new Set(runtimeInputs.map((item) => `${item.baselineId}\0${item.kind}`)).size === runtimeInputs.length &&
      expected.every(({ baselineId, kind }) =>
        runtimeInputs.some((item) => item.baselineId === baselineId && item.kind === kind),
      ),
    'reviewed-runtime-inputs-required',
  );
  for (const input of runtimeInputs) {
    const match = expected.find((item) => item.baselineId === input.baselineId && item.kind === input.kind);
    check(
      input.role === 'source-derived' &&
        match?.producers.get(input.producerAstSha256) === input.kind &&
        typeof input.reviewedBy === 'string' &&
        input.reviewedBy.length &&
        typeof input.reason === 'string' &&
        input.reason.trim().length >= 20,
      'unknown-runtime-input-producer',
    );
  }
  return { runtimeInputs, classify, externalKind };
}

function reviewLateImportOrder(model, currentModel, selected, file, fixtureSlice) {
  const lateImports = file.lateImports ?? [];
  check(Array.isArray(lateImports), 'invalid-late-import-review');
  const oldLate = new Set(),
    currentLate = new Set();
  const importsWithin = (node) => {
    const found = [];
    function visit(item) {
      if (item.type === 'ImportExpression') found.push(item);
      childNodes(item).forEach(visit);
    }
    visit(node);
    return found;
  };
  for (const reviewed of lateImports) {
    check(
      fixtureSlice &&
        reviewed.role === 'post-selected-isolated' &&
        typeof reviewed.reviewedBy === 'string' &&
        reviewed.reviewedBy.length &&
        typeof reviewed.reason === 'string' &&
        reviewed.reason.trim().length >= 20 &&
        typeof reviewed.baselineId === 'string' &&
        SHA.test(reviewed.importAstSha256) &&
        typeof reviewed.source === 'string' &&
        /^\.\.?\//u.test(reviewed.source) &&
        !/[?#\\]/u.test(reviewed.source),
      'invalid-late-import-review',
    );
    const oldRow = model.registrations.find((row) => row.id === reviewed.baselineId);
    const matches = currentModel.registrations.filter(
      (row) => row.titleExpressionSha256 === oldRow?.titleExpressionSha256,
    );
    check(oldRow && matches.length === 1, 'invalid-late-import-review');
    const currentRow = matches[0];
    const topLevel = (candidate) =>
      !candidate.parent &&
      candidate.statement?.type === 'ExpressionStatement' &&
      candidate.statement.expression === candidate.node &&
      candidate.node.arguments.length === 2 &&
      candidate.node.arguments[1] === candidate.callback;
    check(
      topLevel(oldRow) &&
        topLevel(currentRow) &&
        selected.every(
          ({ old, current }) =>
            model.registrations.indexOf(oldRow) > model.registrations.indexOf(old) &&
            currentModel.registrations.indexOf(currentRow) > currentModel.registrations.indexOf(current),
        ),
      'late-import-order-unproven',
    );
    const matching = (row) =>
      importsWithin(row.callback.body).filter(
        (item) =>
          parityAstHash(item) === reviewed.importAstSha256 &&
          item.source.type === 'Literal' &&
          item.source.value === reviewed.source,
      );
    const oldMatches = matching(oldRow),
      currentMatches = matching(currentRow);
    check(
      oldMatches.length === 1 &&
        currentMatches.length === 1 &&
        !oldLate.has(oldMatches[0]) &&
        !currentLate.has(currentMatches[0]),
      'invalid-late-import-review',
    );
    oldLate.add(oldMatches[0]);
    currentLate.add(currentMatches[0]);
  }
  function forbidden(node, permitted = new Set()) {
    check(
      (node.type !== 'ImportExpression' || permitted.has(node)) &&
        !(
          node.type === 'CallExpression' &&
          node.callee.type === 'Identifier' &&
          ['require', 'eval'].includes(node.callee.name)
        ),
      'dynamic-import-input-unsupported',
    );
    childNodes(node).forEach((child) => forbidden(child, permitted));
  }
  forbidden(model.ast, oldLate);
  if (currentModel) forbidden(currentModel.ast, currentLate);
  return { lateImports, forbidden };
}

function reviewAdditionalInputDependencies(root, model, currentModel, selected, file, memorySlice) {
  const dependencies = new Map();
  const addedInputs = file.additionalInputDependencies ?? [];
  check(Array.isArray(addedInputs) && (memorySlice || addedInputs.length === 0), 'invalid-added-input-review');
  if (memorySlice) {
    const scopes = require('eslint-scope').analyze(currentModel.ast, { ecmaVersion: 2022, sourceType: 'module' });
    const references = new Map();
    for (const scope of scopes.scopes)
      for (const reference of scope.references) references.set(reference.identifier, reference.resolved);
    const imports = currentModel.ast.body.filter(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.source.value === 'node:fs' &&
        node.specifiers.some(
          (part) =>
            part.type === 'ImportSpecifier' &&
            part.imported.name === 'readFileSync' &&
            part.local.name === 'readFileSync',
        ),
    );
    const oldImports = model.ast.body.filter(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.source.value === 'node:fs' &&
        node.specifiers.some((part) => part.local.name === 'readFileSync'),
    );
    check(imports.length <= 1 && oldImports.length === 0, 'unsupported-added-input-read');
    const used = new Set();
    function scanCurrent(node, ancestors = []) {
      if (node.type === 'Identifier' && node.name === 'readFileSync') {
        const parent = ancestors.at(-1);
        if (parent?.type !== 'ImportSpecifier') {
          const call = parent,
            url = call?.arguments?.[0],
            meta = url?.arguments?.[1];
          check(
            imports.length === 1 &&
              references.get(node)?.defs?.length === 1 &&
              references.get(node).defs[0].type === 'ImportBinding' &&
              references.get(node).defs[0].parent === imports[0] &&
              call?.type === 'CallExpression' &&
              call.callee === node &&
              call.arguments.length === 1 &&
              url?.type === 'NewExpression' &&
              url.callee.type === 'Identifier' &&
              url.callee.name === 'URL' &&
              references.has(url.callee) &&
              !references.get(url.callee) &&
              !currentModel.declarations.some((item) => item.name === 'URL' || item.name === 'readFileSync') &&
              url.arguments.length === 2 &&
              url.arguments[0]?.type === 'Literal' &&
              typeof url.arguments[0].value === 'string' &&
              /^\.\.?\//u.test(url.arguments[0].value) &&
              !/[?#\\]/u.test(url.arguments[0].value) &&
              meta?.type === 'MemberExpression' &&
              !meta.computed &&
              meta.property.name === 'url' &&
              meta.object.type === 'MetaProperty' &&
              meta.object.meta.name === 'import' &&
              meta.object.property.name === 'meta' &&
              currentModel.registrations.some(
                (row) => ancestors.includes(row.callback) && !selected.some((item) => item.current === row),
              ),
            'unsupported-added-input-read',
          );
          const relative = path
            .relative(root, path.resolve(root, path.dirname(file.path), url.arguments[0].value))
            .replaceAll(path.sep, '/');
          const matches = addedInputs.filter(
            (item) => item.path === relative && item.readAstSha256 === parityAstHash(call),
          );
          check(
            matches.length === 1 &&
              !used.has(matches[0]) &&
              SHA.test(matches[0].sha256) &&
              typeof matches[0].reviewedBy === 'string' &&
              matches[0].reviewedBy.length &&
              typeof matches[0].reason === 'string' &&
              matches[0].reason.trim().length >= 20,
            'invalid-added-input-review',
          );
          const absolute = requirePublicCdnPath(root, relative, null, true);
          check(parityHash(fs.readFileSync(absolute)) === matches[0].sha256, 'changed-test-input-dependency');
          used.add(matches[0]);
          dependencies.set(relative, matches[0].sha256);
        }
      }
      childNodes(node).forEach((child) => scanCurrent(child, [...ancestors, node]));
    }
    scanCurrent(currentModel.ast);
    check(used.size === addedInputs.length, 'invalid-added-input-review');
  }
  return dependencies;
}

function reviewInputDependencyClosure({
  root,
  file,
  roles,
  generated,
  dependencies,
  assets,
  readBaseline,
  safeBuiltin,
  forbidden,
  externalKind,
  classify,
  builtinExternal,
}) {
  for (const source of generated.handledInputSources ?? [])
    check(
      roles.some((role) => role.source === source && role.role === 'test-input'),
      'generated-fixture-input-role-required',
    );
  for (const dependency of generated.dependencies ?? []) {
    check(
      SHA.test(dependency.sha256) &&
        parityHash(fs.readFileSync(confined(root, dependency.path))) === dependency.sha256 &&
        parityHash(Buffer.from(readBaseline(dependency.path))) === dependency.sha256,
      'changed-test-input-dependency',
    );
    dependencies.set(dependency.path, dependency.sha256);
  }
  function visit(from, specifier, asset = false) {
    check(
      typeof specifier === 'string' &&
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !/[?#\\]/u.test(specifier),
      'unsupported-test-input-import',
    );
    const relative = path.relative(root, path.resolve(root, path.dirname(from), specifier)).replaceAll(path.sep, '/');
    const absolute = confined(root, relative);
    if (dependencies.has(relative)) return;
    const bytes = fs.readFileSync(absolute);
    const baseline = readBaseline(relative);
    check(parityHash(bytes) === parityHash(Buffer.from(baseline)), 'changed-test-input-dependency');
    dependencies.set(relative, parityHash(bytes));
    if (asset || relative.endsWith('.json')) return;
    check(/\.[cm]?js$/u.test(relative), 'unsupported-test-input-import');
    const ast = parse(bytes.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    forbidden(ast);
    ast.body.forEach((node) => safeBuiltin(node));
    function rejectExternal(node) {
      check(
        !externalKind(node) &&
          !(
            node.type === 'ImportDeclaration' &&
            (builtinExternal.test(node.source.value) || ['node:fs', 'node:fs/promises'].includes(node.source.value))
          ),
        'external-test-input-unsupported',
      );
      childNodes(node).forEach(rejectExternal);
    }
    rejectExternal(ast);
    const inputKinds = new Set();
    classify(ast, null, inputKinds, false);
    check(inputKinds.size === 0, 'external-test-input-unsupported');
    for (const node of ast.body) {
      if (
        node.type === 'ImportDeclaration' ||
        (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
      ) {
        const source = node.source.value;
        if (!source.startsWith('node:')) visit(relative, source);
      }
    }
  }
  for (const role of roles.filter((item) => item.role === 'test-input'))
    if (!generated.handledInputSources?.has(role.source)) visit(file.path, role.source);
  for (const asset of assets) visit(file.path, asset, true);
}

function reviewedImports(
  root,
  file,
  model,
  readBaseline,
  selected,
  { generated = {}, currentModel, fixtureSlice = false, memorySlice = false } = {},
) {
  const { roles, safeBuiltin, builtinExternal } = reviewStaticImportRoles(model, file, generated);
  const assets = collectReviewedAssets(model, generated);
  const { runtimeInputs, classify, externalKind } = reviewRuntimeInputs(model, file, selected, generated);
  const { lateImports, forbidden } = reviewLateImportOrder(model, currentModel, selected, file, fixtureSlice);
  const dependencies = reviewAdditionalInputDependencies(root, model, currentModel, selected, file, memorySlice);
  reviewInputDependencyClosure({
    root,
    file,
    roles,
    generated,
    dependencies,
    assets,
    readBaseline,
    safeBuiltin,
    forbidden,
    externalKind,
    classify,
    builtinExternal,
  });
  return {
    roles,
    runtimeInputs,
    generatedFixtures: generated.fixtures ?? [],
    lateImports,
    dependencies: [...dependencies].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 })),
  };
}
function reviewIsolatedRegistrationChanges({ review, fixtureSlice, oldModel, currentModel, used, file, replacements }) {
  for (const change of review.isolatedRegistrationChanges ?? []) {
    check(
      fixtureSlice &&
        change.zeroSelectedCredit === true &&
        typeof change.reviewedBy === 'string' &&
        change.reviewedBy.length > 0 &&
        typeof change.reason === 'string' &&
        change.reason.trim().length >= 20 &&
        SHA.test(change.titleExpressionSha256) &&
        SHA.test(change.oldBodyAstSha256) &&
        SHA.test(change.currentBodyAstSha256),
      'invalid-isolated-registration-review',
    );
    const before = oldModel.registrations.filter(
      (row) =>
        row.titleExpressionSha256 === change.titleExpressionSha256 &&
        parityAstHash(row.callback.body) === change.oldBodyAstSha256,
    );
    const after = currentModel.registrations.filter(
      (row) =>
        row.titleExpressionSha256 === change.titleExpressionSha256 &&
        parityAstHash(row.callback.body) === change.currentBodyAstSha256,
    );
    const protectedAncestor = (row) => {
      for (let current = row; current; current = current.parent)
        if (current.kinds.some((kind) => ['parity', 'security'].includes(kind))) return true;
      return false;
    };
    check(
      before.length === 1 &&
        after.length === 1 &&
        !used.has(after[0].callback.body) &&
        !(file.guarantees ?? []).some((guarantee) =>
          guarantee.tests.some((spec) => spec.baselineId === before[0].id),
        ) &&
        !oldModel.tags.fileKinds?.some((kind) => ['parity', 'security'].includes(kind)) &&
        !protectedAncestor(before[0]) &&
        before[0].node.arguments.length === 2 &&
        after[0].node.arguments.length === 2 &&
        before[0].node.arguments[1] === before[0].callback &&
        after[0].node.arguments[1] === after[0].callback &&
        parityAstHash({ ...before[0].callback, body: null }) === parityAstHash({ ...after[0].callback, body: null }),
      'invalid-isolated-registration-review',
    );
    replacements.set(after[0].callback.body, before[0].callback.body);
    used.add(after[0].callback.body);
  }
}

function reviewIsolatedDeclarations({ review, fixtureSlice, memorySlice, currentModel, oldModel, ignored }) {
  for (const addition of review.isolatedDeclarations ?? []) {
    check(
      fixtureSlice &&
        addition.zeroSelectedCredit === true &&
        typeof addition.reviewedBy === 'string' &&
        addition.reviewedBy.length > 0 &&
        typeof addition.reason === 'string' &&
        addition.reason.trim().length >= 20 &&
        SHA.test(addition.astSha256),
      'invalid-isolated-declaration-review',
    );
    const matches = currentModel.ast.body.filter((node) => parityAstHash(node) === addition.astSha256);
    check(
      matches.length === 1 &&
        !oldModel.ast.body.some((node) => parityAstHash(node) === addition.astSha256) &&
        (matches[0].type === 'FunctionDeclaration' ||
          (memorySlice &&
            matches[0].type === 'ImportDeclaration' &&
            matches[0].source.value === 'node:fs' &&
            matches[0].specifiers.every(
              (part) =>
                part.type === 'ImportSpecifier' &&
                part.imported.name === 'readFileSync' &&
                part.local.name === 'readFileSync',
            )) ||
          (matches[0].type === 'ImportDeclaration' &&
            matches[0].source.value === 'node:crypto' &&
            matches[0].specifiers.every(
              (part) => part.type === 'ImportSpecifier' && part.imported.name === 'createHash',
            ))),
      'invalid-isolated-declaration-review',
    );
    ignored.add(matches[0]);
  }
}

function reviewOneAssertionCorrection({
  correction,
  originalAssertions,
  currentAssertions,
  used,
  proofContext,
  file,
  oldModel,
  currentModel,
  securityApprovals,
  staticExpected,
  root,
  enumBindings,
  replacements,
}) {
  check(
    correction.sameGuarantee === true &&
      typeof correction.reviewedBy === 'string' &&
      correction.reviewedBy.length &&
      typeof correction.reason === 'string' &&
      correction.reason.trim().length >= 20 &&
      SHA.test(correction.oldAstSha256) &&
      SHA.test(correction.currentAstSha256) &&
      correction.oldAstSha256 !== correction.currentAstSha256,
    'invalid-correction-review',
  );
  const old = originalAssertions.filter(
    (item) =>
      item.sha256 === correction.oldAstSha256 && (!correction.baselineId || item.row.id === correction.baselineId),
  );
  const current = currentAssertions.filter(
    (item) =>
      item.sha256 === correction.currentAstSha256 &&
      (!correction.baselineId ||
        old.some((prior) => prior.row.titleExpressionSha256 === item.row.titleExpressionSha256)),
  );
  check(
    old.length === 1 &&
      current.length === 1 &&
      old[0].row.titleExpressionSha256 === current[0].row.titleExpressionSha256 &&
      !used.has(current[0].node),
    'ambiguous-correction',
  );
  const secured = (row, model) => {
    if (model.tags.fileKinds?.includes('security')) return true;
    for (let ancestor = row; ancestor; ancestor = ancestor.parent) if (ancestor.kinds.includes('security')) return true;
    return false;
  };
  const security = secured(old[0].row, oldModel) || secured(current[0].row, currentModel);
  if (security) {
    const approval = proofContext.securityApproval?.receipt;
    const before = old[0].node,
      after = current[0].node;
    check(
      approval?.authority === 'directhumanreplyinrootchat' &&
        approval.answer === 'Approve this exact expectation change' &&
        approval.file === file.path &&
        approval.baselineId === old[0].row.id &&
        approval.originalAssertionSha256 === old[0].sha256 &&
        approval.currentAssertionSha256 === current[0].sha256 &&
        approval.baselineSourceSha256 === parityHash(oldModel.source) &&
        approval.currentSourceSha256 === parityHash(currentModel.source) &&
        SHA.test(approval.operationAstSha256) &&
        parityAstHash(before.arguments[0]) === approval.operationAstSha256 &&
        parityAstHash(after.arguments[0]) === approval.operationAstSha256 &&
        before.arguments[0]?.arguments?.[1]?.value === approval.exactInput &&
        before.arguments[1]?.value === approval.oldExpected &&
        after.arguments[1]?.value === approval.approvedExpected &&
        Array.isArray(approval.unchangedLongAssertionHashes) &&
        approval.unchangedLongAssertionHashes.length === 2 &&
        jsonHash(old[0].row.assertions.map((item) => item.sha256)) ===
          jsonHash([...approval.unchangedLongAssertionHashes, old[0].sha256]) &&
        jsonHash(current[0].row.assertions.map((item) => item.sha256)) ===
          jsonHash([...approval.unchangedLongAssertionHashes, current[0].sha256]),
      'security-correction-requires-user-authorization',
    );
    securityApprovals.push({
      sha256: proofContext.securityApproval.sha256,
      file: file.path,
      baselineId: approval.baselineId,
      originalAssertionSha256: old[0].sha256,
      currentAssertionSha256: current[0].sha256,
      operationAstSha256: approval.operationAstSha256,
    });
  }
  const protectedParity = (row, model) => {
    if (model.tags.fileKinds?.includes('parity')) return true;
    for (let ancestor = row; ancestor; ancestor = ancestor.parent) if (ancestor.kinds.includes('parity')) return true;
    return false;
  };
  if (protectedParity(old[0].row, oldModel)) {
    const lines = currentModel.source.split(/\r?\n/u);
    const start = current[0].node.loc.start.line - 1;
    const nearby = lines.slice(Math.max(0, start - 3), start);
    check(
      nearby.some(
        (line) =>
          /\/\/\s*@parity-evidence:\s*\S/u.test(line) &&
          line.includes(correction.guaranteeId) &&
          !oldModel.source.split(/\r?\n/u).includes(line),
      ),
      'new-parity-evidence-comment-required',
    );
  }
  const a = old[0].node,
    b = current[0].node;
  const nullCorrection =
    b.arguments[1]?.type === 'Literal' &&
    b.arguments[1].value === null &&
    a.arguments[1]?.type === 'Identifier' &&
    (() => {
      const scopes = analyzeScopes(oldModel.ast, { ecmaVersion: 2022, sourceType: 'module' });
      const ref = scopes.scopes.flatMap((scope) => scope.references).find((item) => item.identifier === a.arguments[1]);
      if (a.arguments[1].name === 'undefined') return ref && !ref.resolved;
      const variable = ref?.resolved,
        definition = variable?.defs?.[0];
      return (
        variable?.defs.length === 1 &&
        definition?.type === 'Variable' &&
        definition.parent?.kind === 'const' &&
        !variable.references.some((item) => item.isWrite() && !item.init)
      );
    })();
  const enumCorrection =
    file.path === 'mirage/test/power-fx-canvas-common.test.mjs' &&
    correction.baselineId === 'mirage/test/power-fx-canvas-common.test.mjs:25:0' &&
    correction.oldAstSha256 === '751143e212a23217f691343564ea7d81c7082739681a37de242e710bfb8ad199' &&
    correction.currentAstSha256 === 'e041b987f2a5514cf56fd2f73edf5473137c763bb9178d308e9c60d34e041b5a' &&
    a.arguments[1]?.type === 'MemberExpression' &&
    !a.arguments[1].computed &&
    a.arguments[1].object?.name === 'ErrorKind' &&
    a.arguments[1].property?.name === 'InvalidArgument' &&
    b.arguments[1]?.type === 'MemberExpression' &&
    !b.arguments[1].computed &&
    b.arguments[1].object?.name === 'ErrorKind' &&
    b.arguments[1].property?.name === 'Numeric';
  check(
    [2, 3].includes(a.arguments.length) &&
      b.arguments.length === a.arguments.length &&
      (a.arguments.length === 2 || parityAstHash(a.arguments[2]) === parityAstHash(b.arguments[2])) &&
      ((staticExpected(a.arguments[1]) && staticExpected(b.arguments[1])) || enumCorrection || nullCorrection) &&
      parityAstHash(a.callee) === parityAstHash(b.callee) &&
      parityAstHash(a.arguments[0]) === parityAstHash(b.arguments[0]),
    'correction-changes-producer-or-input',
  );
  const guarantee = (file.guarantees ?? []).find((item) => item.id === correction.guaranteeId);
  check(guarantee && Array.isArray(correction.factIds) && correction.factIds.length, 'correction-proof-required');
  if (security)
    check(
      correction.factIds.every((id) =>
        guarantee.proofs.some(
          (proof) => proof.mode === 'official-package' && proof.facts.some((fact) => fact.id === id),
        ),
      ),
      'security-correction-official-proof-required',
    );
  const facts = new Set(guarantee.proofs.flatMap((proof) => prove(root, proof, proofContext)));
  check(
    correction.factIds.every((id) => facts.has(id)),
    'correction-proof-required',
  );
  if (nullCorrection) {
    const matching = guarantee.proofs.flatMap((proof) =>
      proof.facts.filter((fact) => correction.factIds.includes(fact.id)).map((fact) => ({ proof, fact })),
    );
    check(
      matching.some(
        ({ proof, fact }) =>
          pointer(JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8')), fact.pointer)?.result?.type ===
          'null',
      ),
      'correction-proof-required',
    );
  }
  if (enumCorrection) {
    const matching = guarantee.proofs.flatMap((proof) =>
      proof.mode === 'official-package'
        ? proof.facts.filter((fact) => correction.factIds.includes(fact.id)).map((fact) => ({ proof, fact }))
        : [],
    );
    check(
      matching.length > 0 &&
        matching.every(({ proof, fact }) => {
          const value = pointer(JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8')), fact.pointer);
          return (
            value?.expression === 'RandBetween(3,2)' &&
            value.kind === 'error' &&
            value.value?.errors?.[0]?.kind === 24 &&
            value.value.errors[0].kindName === 'Numeric'
          );
        }),
      'correction-proof-required',
    );
    const imports = currentModel.ast.body.filter(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.source.value === '../lib/power-fx.mjs' &&
        node.specifiers.some(
          (part) =>
            part.type === 'ImportSpecifier' && part.imported.name === 'ErrorKind' && part.local.name === 'ErrorKind',
        ),
    );
    check(imports.length === 1, 'correction-changes-producer-or-input');
    enumBindings.push({ name: 'ErrorKind', member: 'Numeric', value: 24 });
  }
  replacements.set(b, a);
  used.add(b);
}

function reviewAssertionCorrections({
  review,
  originalAssertions,
  currentAssertions,
  used,
  proofContext,
  file,
  oldModel,
  currentModel,
  securityApprovals,
  staticExpected,
  root,
  enumBindings,
  replacements,
}) {
  for (const correction of review.corrections)
    reviewOneAssertionCorrection({
      correction,
      originalAssertions,
      currentAssertions,
      used,
      proofContext,
      file,
      oldModel,
      currentModel,
      securityApprovals,
      staticExpected,
      root,
      enumBindings,
      replacements,
    });
}

function reviewFixtureCorrections({
  fixtureCorrections,
  oldModel,
  currentModel,
  file,
  root,
  proofContext,
  fixtureBindings,
  replacements,
  used,
}) {
  for (const correction of fixtureCorrections) {
    check(
      typeof correction.binding === 'string' &&
        Number.isInteger(correction.index) &&
        correction.index >= 0 &&
        correction.sameGuarantee === true &&
        typeof correction.reviewedBy === 'string' &&
        correction.reviewedBy.length &&
        typeof correction.reason === 'string' &&
        correction.reason.trim().length >= 20 &&
        SHA.test(correction.oldAstSha256) &&
        SHA.test(correction.currentAstSha256) &&
        correction.oldAstSha256 !== correction.currentAstSha256,
      'invalid-fixture-correction',
    );
    const originals = oldModel.declarations.filter(
      (item) => item.name === correction.binding && item.ownerTitle === null,
    );
    const currents = currentModel.declarations.filter(
      (item) => item.name === correction.binding && item.ownerTitle === null,
    );
    check(
      originals.length === 1 &&
        currents.length === 1 &&
        originals[0].initializer.type === 'ArrayExpression' &&
        currents[0].initializer.type === 'ArrayExpression' &&
        originals[0].initializer.elements.length === currents[0].initializer.elements.length,
      'invalid-fixture-correction',
    );
    const oldEntry = originals[0].initializer.elements[correction.index],
      currentEntry = currents[0].initializer.elements[correction.index];
    check(
      oldEntry?.type === 'ArrayExpression' &&
        currentEntry?.type === 'ArrayExpression' &&
        oldEntry.elements.length === 2 &&
        currentEntry.elements.length === 2 &&
        oldEntry.elements.every(Boolean) &&
        currentEntry.elements.every(Boolean) &&
        parityAstHash(oldEntry) === correction.oldAstSha256 &&
        parityAstHash(currentEntry) === correction.currentAstSha256 &&
        parityAstHash(oldEntry.elements[0]) === parityAstHash(currentEntry.elements[0]) &&
        !used.has(currentEntry),
      'invalid-fixture-correction',
    );
    literalCaseValue(oldEntry.elements[0]);
    literalCaseValue(oldEntry.elements[1]);
    literalCaseValue(currentEntry.elements[1]);
    const uses = (row) => {
      let found = false;
      function visit(node) {
        if (node.type === 'Identifier' && node.name === correction.binding) found = true;
        childNodes(node).forEach(visit);
      }
      visit(row.callback.body);
      return (
        found ||
        row.loops.some(
          (loop) =>
            loop.type === 'ForOfStatement' &&
            loop.right.type === 'Identifier' &&
            loop.right.name === correction.binding,
        )
      );
    };
    const protectedKind = (row, model, kind) => {
      if (model.tags.fileKinds?.includes(kind)) return true;
      for (let ancestor = row; ancestor; ancestor = ancestor.parent) if (ancestor.kinds.includes(kind)) return true;
      return false;
    };
    check(
      !oldModel.registrations.some((row) => uses(row) && protectedKind(row, oldModel, 'security')) &&
        !currentModel.registrations.some((row) => uses(row) && protectedKind(row, currentModel, 'security')),
      'security-correction-requires-user-authorization',
    );
    if (
      oldModel.registrations.some((row) => uses(row) && protectedKind(row, oldModel, 'parity')) ||
      currentModel.registrations.some((row) => uses(row) && protectedKind(row, currentModel, 'parity'))
    ) {
      const lines = currentModel.source.split(/\r?\n/u),
        start = currentEntry.loc.start.line - 1;
      check(
        lines
          .slice(Math.max(0, start - 3), start)
          .some(
            (line) =>
              /\/\/\s*@parity-evidence:\s*\S/u.test(line) &&
              line.includes(correction.guaranteeId) &&
              !oldModel.source.split(/\r?\n/u).includes(line),
          ),
        'new-parity-evidence-comment-required',
      );
    }
    const guarantee = (file.guarantees ?? []).find((item) => item.id === correction.guaranteeId);
    check(guarantee && Array.isArray(correction.factIds) && correction.factIds.length, 'correction-proof-required');
    const facts = new Set(guarantee.proofs.flatMap((proof) => prove(root, proof, proofContext)));
    check(
      correction.factIds.every((id) => facts.has(id)),
      'correction-proof-required',
    );
    const existing = fixtureBindings.get(correction.binding);
    check(
      !existing ||
        (existing.baselineHash === originals[0].initializerAstSha256 &&
          existing.currentHash === currents[0].initializerAstSha256),
      'invalid-fixture-correction',
    );
    fixtureBindings.set(correction.binding, {
      baselineHash: originals[0].initializerAstSha256,
      currentHash: currents[0].initializerAstSha256,
    });
    replacements.set(currentEntry, oldEntry);
    used.add(currentEntry);
  }
}

function reviewAddedTests({ review, oldModel, currentModel, fixtureSlice, ignored }) {
  for (const added of review.addedTests) {
    check(
      added.zeroOriginalCredit === true &&
        added.interactionReviewed === true &&
        typeof added.reviewedBy === 'string' &&
        added.reviewedBy.length &&
        typeof added.reason === 'string' &&
        added.reason.trim().length >= 20 &&
        SHA.test(added.titleExpressionSha256) &&
        SHA.test(added.bodyAstSha256),
      'invalid-added-test-review',
    );
    check(
      !oldModel.registrations.some((row) => row.titleExpressionSha256 === added.titleExpressionSha256),
      'added-test-is-original',
    );
    const matches = currentModel.registrations.filter(
      (row) =>
        row.titleExpressionSha256 === added.titleExpressionSha256 &&
        parityAstHash(row.callback.body) === added.bodyAstSha256,
    );
    check(matches.length === 1, 'ambiguous-added-test');
    check(
      matches[0].node.arguments.length === 2 &&
        matches[0].node.arguments[0].type === 'Literal' &&
        typeof matches[0].node.arguments[0].value === 'string' &&
        matches[0].node.arguments[1] === matches[0].callback &&
        (fixtureSlice || matches[0].callback.params.length === 0) &&
        (fixtureSlice || !matches[0].callback.async) &&
        !matches[0].callback.generator,
      'added-test-isolation-unproven',
    );
    if (!fixtureSlice) noUnreviewedExternal(matches[0].callback.body);
    const isolatedLiteral = (node) =>
      node?.type === 'Literal' ||
      (node?.type === 'UnaryExpression' &&
        ['+', '-', '!', '~'].includes(node.operator) &&
        isolatedLiteral(node.argument)) ||
      (node?.type === 'ArrayExpression' && node.elements.every((item) => item && isolatedLiteral(item)));
    check(
      fixtureSlice ||
        (matches[0].callback.body.body.length > 0 &&
          matches[0].callback.body.body.every(
            (item) =>
              item.type === 'ExpressionStatement' &&
              item.expression.type === 'CallExpression' &&
              matches[0].assertions.some((assertion) => assertion.node === item.expression) &&
              item.expression.arguments.every(isolatedLiteral),
          )),
      'added-test-isolation-unproven',
    );
    const statement = currentModel.ast.body.find(
      (item) => item.type === 'ExpressionStatement' && item.expression === matches[0].node,
    );
    check(statement && !ignored.has(statement), 'unsupported-added-test-context');
    ignored.add(statement);
  }
}

function reviewEnumBinding({ enumBindings, currentModel, ignored }) {
  if (enumBindings.length) {
    const expected = parse(
      "if (ErrorKind.Numeric !== 24) throw new Error('official ErrorKind.Numeric binding changed');",
      { ecmaVersion: 'latest', sourceType: 'module' },
    ).body[0];
    const existing = currentModel.ast.body.filter((node) => parityAstHash(node) === parityAstHash(expected));
    check(
      existing.length <= 1 && (!existing.length || currentModel.ast.body.at(-1) === existing[0]),
      'invalid-enum-binding',
    );
    if (existing.length) ignored.add(existing[0]);
  }
}

function reviewedModuleDeltas(
  root,
  file,
  oldModel,
  currentModel,
  originalGuards,
  proofContext,
  { conciseSpecs, fixtureSlice = false, memorySlice = false },
) {
  const review = file.moduleReview;
  check(
    review &&
      typeof review.reviewedBy === 'string' &&
      review.reviewedBy.length &&
      typeof review.reason === 'string' &&
      review.reason.trim().length >= 20 &&
      Array.isArray(review.corrections) &&
      Array.isArray(review.addedTests),
    'reviewed-module-deltas-required',
  );
  const replacements = new Map(),
    ignored = new Set(),
    used = new Set(),
    fixtureBindings = new Map(),
    securityApprovals = [],
    enumBindings = [];
  const originalAssertions = oldModel.registrations.flatMap((row) => row.assertions.map((item) => ({ ...item, row })));
  const currentAssertions = currentModel.registrations.flatMap((row) =>
    row.assertions.map((item) => ({ ...item, row })),
  );
  const staticExpected = (node) =>
    node?.type === 'Literal' ||
    (node?.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) && node.argument.type === 'Literal');
  reviewIsolatedRegistrationChanges({ review, fixtureSlice, oldModel, currentModel, used, file, replacements });
  reviewIsolatedDeclarations({ review, fixtureSlice, memorySlice, currentModel, oldModel, ignored });
  reviewAssertionCorrections({
    review,
    originalAssertions,
    currentAssertions,
    used,
    proofContext,
    file,
    oldModel,
    currentModel,
    securityApprovals,
    staticExpected,
    root,
    enumBindings,
    replacements,
  });
  const fixtureCorrections = review.fixtureCorrections ?? [];
  check(Array.isArray(fixtureCorrections), 'invalid-fixture-correction');
  reviewFixtureCorrections({
    fixtureCorrections,
    oldModel,
    currentModel,
    file,
    root,
    proofContext,
    fixtureBindings,
    replacements,
    used,
  });
  reviewAddedTests({ review, oldModel, currentModel, fixtureSlice, ignored });
  reviewEnumBinding({ enumBindings, currentModel, ignored });
  check(
    moduleContextHash(oldModel, { originalGuards, conciseSpecs }) ===
      moduleContextHash(currentModel, { replacements, ignored, originalGuards, conciseSpecs }),
    'changed-module-context',
  );
  return { review, replacements, fixtureBindings, securityApprovals, enumBindings };
}

function collectPartialWrapperEdits(model, source, descriptors, edits) {
  let wrappers = 0;
  for (const row of model.registrations) {
    if (row.callback.body.type !== 'BlockStatement') continue;
    const body = row.callback.body.body;
    const directCall = body[0]?.type === 'ExpressionStatement' && body[0].expression;
    if (directCall?.type === 'CallExpression' && directCall.callee.name === REGION_IMPORT) {
      const bindings = guardDescriptors({ ...directCall, callee: { type: 'Identifier', name: IMPORT } });
      check(
        bindings.length === 1 &&
          bindings[0].originalCallbackExpression &&
          descriptors.some((item) => jsonHash(item) === jsonHash(bindings[0])) &&
          body.length === 2 &&
          body[1].type === 'ReturnStatement' &&
          body[1].argument,
        'unbound-existing-partial',
      );
      edits.push({
        start: row.callback.body.range[0],
        end: row.callback.body.range[1],
        text: `(${source.slice(...body[1].argument.range)})`,
      });
      wrappers++;
      continue;
    }
    for (const statement of body) {
      if (
        statement.type !== 'BlockStatement' ||
        statement.body[0]?.type !== 'ExpressionStatement' ||
        statement.body[0].expression?.type !== 'CallExpression' ||
        statement.body[0].expression.callee.name !== REGION_IMPORT
      )
        continue;
      const call = statement.body[0].expression;
      const bindings = guardDescriptors({ ...call, callee: { type: 'Identifier', name: IMPORT } });
      check(
        bindings.length === 1 && descriptors.some((item) => jsonHash(item) === jsonHash(bindings[0])),
        'unbound-existing-partial',
      );
      edits.push({
        start: statement.range[0],
        end: statement.range[1],
        text: source.slice(statement.body[0].range[1], statement.range[1] - 1),
      });
      wrappers++;
    }
  }
  return wrappers;
}
function unwrapExistingPartial(root, file, source, model, oldModel, validatedToken) {
  const imports = model.ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === REGION_IMPORT),
  );
  if (!imports.length) return null;
  check(imports.length === 1, 'ambiguous-existing-partial');
  const declaration = imports[0];
  const resolved = declaration.source.value.startsWith('file:')
    ? fileURLToPath(declaration.source.value)
    : path.resolve(root, path.dirname(file.path), declaration.source.value);
  check(
    resolved === TOOL &&
      declaration.specifiers.every(
        (item) =>
          item.type === 'ImportSpecifier' &&
          ((item.local.name === REGION_IMPORT && item.imported.name === 'parityAssertions') ||
            (item.local.name === IMPORT && item.imported.name === 'assertParityBindings')),
      ),
    'invalid-existing-partial-import',
  );
  const guards = model.ast.body.filter(
    (item) =>
      item.type === 'ExpressionStatement' &&
      item.expression.type === 'CallExpression' &&
      item.expression.callee.name === IMPORT,
  );
  check(guards.length > 0, 'existing-partial-source-guard-required');
  const descriptors = guards.flatMap((item) => guardDescriptors(item.expression));
  check(new Set(descriptors.map((item) => item.baselineId)).size === descriptors.length, 'duplicate-protected-binding');
  const legacy = descriptors.some((descriptor) => !Array.isArray(descriptor.originalGuardHashes));
  const baselineGuards = oldModel.registrations.flatMap((row) => row.assertions.filter(isHashGuard));
  check(!legacy || baselineGuards.length === 0, 'legacy-original-guard-migration-unsupported');
  if (validatedToken !== CONTEXT_VALIDATED)
    validateParityBindings(pathToFileURL(path.resolve(root, file.path)), descriptors, {
      legacyOriginalGuards: legacy ? [] : undefined,
    });
  const edits = [
    { start: declaration.range[0], end: declaration.range[1], text: '' },
    ...guards.map((item) => ({ start: item.range[0], end: item.range[1], text: '' })),
  ];
  const wrappers = collectPartialWrapperEdits(model, source, descriptors, edits);
  check(wrappers === descriptors.reduce((n, item) => n + (item.regionHashes?.length ?? 0), 0), 'changed-region-set');
  let unwrapped = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    unwrapped = unwrapped.slice(0, edit.start) + edit.text + unwrapped.slice(edit.end);
  return { descriptors, source: unwrapped };
}
function unwrapExistingCase(root, file, source, model, selectedIds = new Set()) {
  const imports = model.ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === CASE_IMPORT),
  );
  if (!imports.length) return null;
  check(imports.length === 1, 'ambiguous-existing-case-guard');
  const declaration = imports[0];
  const resolved = declaration.source.value.startsWith('file:')
    ? fileURLToPath(declaration.source.value)
    : path.resolve(root, path.dirname(file.path), declaration.source.value);
  check(
    resolved === TOOL &&
      declaration.specifiers.length >= 1 &&
      declaration.specifiers.length <= 2 &&
      declaration.specifiers.every(
        (item) =>
          item.type === 'ImportSpecifier' &&
          ((item.local.name === CASE_IMPORT && item.imported.name === 'parityCaseBindings') ||
            (item.local.name === IMPORT && item.imported.name === 'assertParityBindings')),
      ),
    'invalid-existing-case-import',
  );
  const guards = model.ast.body.filter(
    (item) =>
      item.type === 'ExpressionStatement' &&
      item.expression.type === 'CallExpression' &&
      item.expression.callee.name === IMPORT,
  );
  check(guards.length === 1, 'existing-case-source-guard-required');
  const descriptors = guardDescriptors(guards[0].expression);
  check(descriptors.length === 1 && descriptors[0].caseSelection, 'invalid-existing-case-guard');
  validateParityBindings(pathToFileURL(path.resolve(root, file.path)), descriptors);
  if (!selectedIds.has(descriptors[0].baselineId)) return { descriptors, source, caseGuard: true, preserveOnly: true };
  const row = registration(model, descriptors[0]);
  const body = row.callback.body.body;
  check(body?.length === 2 && body[1]?.type === 'ReturnStatement' && body[1].argument, 'invalid-existing-case-guard');
  const edits = [
    { start: declaration.range[0], end: declaration.range[1], text: '' },
    { start: guards[0].range[0], end: guards[0].range[1], text: '' },
    {
      start: row.callback.body.range[0],
      end: row.callback.body.range[1],
      text: `(${source.slice(...body[1].argument.range)})`,
    },
  ];
  let unwrapped = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    unwrapped = unwrapped.slice(0, edit.start) + edit.text + unwrapped.slice(edit.end);
  return { descriptors, source: unwrapped, caseGuard: true };
}
// The isolated-fixture analyzer sees the original test AST, with existing whole-test
// guard scaffolding temporarily removed only after its runtime bindings validate.
function existingSliceValidation(model, baselineModel, descriptors, preservedCaseIds) {
  let validation = descriptors;
  if (descriptors.some((descriptor) => !SHA.test(descriptor.moduleContextAstSha256))) {
    check(
      baselineModel &&
        descriptors.every(
          (descriptor) =>
            !descriptor.moduleContextAstSha256 &&
            !descriptor.originalGuardHashes &&
            !descriptor.importRoles &&
            !descriptor.inputDependencies,
        ),
      'unsupported-legacy-slice-guard',
    );
    const originalGuards = new Set(
      baselineModel.registrations.flatMap((row) => row.assertions.filter(isHashGuard).map((item) => item.sha256)),
    );
    check(originalGuards.size === 0, 'legacy-original-guard-migration-unsupported');
    for (const descriptor of descriptors) {
      const old = baselineModel.registrations.find((row) => row.id === descriptor.baselineId);
      check(
        old &&
          jsonHash(old.assertions.map((item) => item.sha256)) === jsonHash(descriptor.originalAssertions) &&
          parityAstHash(strippedBody(old, originalGuards, new Map(), old.callback.expression)) ===
            descriptor.originalBodyAstSha256,
        'legacy-original-body-mismatch',
      );
    }
    const conciseSpecs = baselineModel.registrations
      .filter(
        (row) =>
          row.callback.type === 'ArrowFunctionExpression' && row.callback.expression && !preservedCaseIds.has(row.id),
      )
      .map((row) => ({
        titleExpressionSha256: row.titleExpressionSha256,
        ...(row.parent ? { parentTitleExpressionSha256: row.parent.titleExpressionSha256 } : {}),
      }));
    const context = moduleContextHash(model, { originalGuards, conciseSpecs });
    validation = descriptors.map((descriptor) => ({
      ...descriptor,
      originalGuardHashes: [],
      moduleContextAstSha256: context,
      importRoles: [],
      inputDependencies: [],
      ...(conciseSpecs.length ? { conciseSpecs } : {}),
    }));
  }
  return validation;
}
function preservedFixtureCaseIds(root, file, model, retainModuleScaffolding) {
  if (!retainModuleScaffolding) return new Set();
  const caseGuards = model.ast.body.filter(
    (item) =>
      item.type === 'ExpressionStatement' &&
      item.expression?.type === 'CallExpression' &&
      item.expression.callee?.name === IMPORT,
  );
  if (!caseGuards.length) return new Set();
  check(caseGuards.length === 1, 'invalid-existing-case-guard');
  const bindings = guardDescriptors(caseGuards[0].expression);
  check(bindings.length === 1 && bindings[0].caseSelection, 'invalid-existing-case-guard');
  validateParityBindings(pathToFileURL(path.resolve(root, file.path)), bindings);
  return new Set(bindings.map((item) => item.baselineId));
}
function analyzeFixtureSliceWithExistingGuards(
  root,
  file,
  model,
  selected,
  readBaseline,
  implementationSources,
  { analyzer = analyzeUnselectedFixtureSlice, baselineModel, retainModuleScaffolding = false } = {},
) {
  const imports = model.ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((part) => part.local.name === SOURCE_IMPORT),
  );
  if (!imports.length)
    return analyzer({
      ast: model.ast,
      selected,
      root,
      filePath: file.path,
      readBaseline,
      implementationSources,
    });
  check(imports.length === 1, 'invalid-existing-slice-guard');
  const declaration = imports[0];
  const resolved = declaration.source.value.startsWith('file:')
    ? fileURLToPath(declaration.source.value)
    : path.resolve(root, path.dirname(file.path), declaration.source.value);
  check(
    resolved === TOOL &&
      declaration.specifiers.length === 2 &&
      declaration.specifiers.every(
        (item) =>
          item.type === 'ImportSpecifier' &&
          ((item.local.name === IMPORT && item.imported.name === 'assertParityBindings') ||
            (item.local.name === SOURCE_IMPORT && item.imported.name === 'assertParityBindingsFromSource')),
      ),
    'invalid-existing-slice-guard',
  );
  const guards = model.ast.body.filter(
    (item) =>
      item.type === 'ExpressionStatement' &&
      item.expression.type === 'CallExpression' &&
      item.expression.arguments.length === 2 &&
      /^parity source bindings [a-f0-9]{16}$/u.test(item.expression.arguments[0]?.value ?? '') &&
      model.registrations.some(
        (row) => row.node === item.expression && !row.parent && isSourceGuardCallback(model, row.callback),
      ),
  );
  check(guards.length === 1, 'invalid-existing-slice-guard');
  check(
    model.registrations.some((row) => row.node === guards[0].expression && !row.parent),
    'invalid-existing-slice-guard',
  );
  const saved = [],
    descriptors = [];
  const preservedCaseIds = preservedFixtureCaseIds(root, file, model, retainModuleScaffolding);
  for (const row of model.registrations) {
    const body = row.callback.body;
    if (body.type !== 'BlockStatement') continue;
    const calls = body.body.filter(
      (statement) =>
        statement.type === 'ExpressionStatement' &&
        statement.expression?.type === 'CallExpression' &&
        statement.expression.callee?.name === IMPORT,
    );
    if (!calls.length) continue;
    check(calls.length === 1 && calls[0] === body.body[0], 'invalid-existing-slice-guard');
    const bound = guardDescriptors(calls[0].expression);
    check(bound.length === 1, 'invalid-existing-slice-guard');
    descriptors.push(...bound);
    saved.push({ body, statements: body.body });
  }
  check(descriptors.length > 0, 'invalid-existing-slice-guard');
  check(new Set(descriptors.map((item) => item.baselineId)).size === descriptors.length, 'duplicate-protected-binding');
  const validation = existingSliceValidation(model, baselineModel, descriptors, preservedCaseIds);
  validateParityBindings(pathToFileURL(path.resolve(root, file.path)), validation);
  const originalBody = model.ast.body;
  try {
    if (!retainModuleScaffolding)
      model.ast.body = originalBody.filter((node) => node !== declaration && node !== guards[0]);
    for (const item of saved) item.body.body = item.statements.slice(1);
    return analyzer({
      ast: model.ast,
      selected,
      root,
      filePath: file.path,
      readBaseline,
      implementationSources,
    });
  } finally {
    model.ast.body = originalBody;
    for (const item of saved) item.body.body = item.statements;
  }
}

// Each selected callback must independently pass the complete isolation proof.
// Keep exemptions tied to the exact nodes returned for this AST.
function addMixedContextIdentifiers(selected, mixed) {
  for (const item of selected) {
    const callback = item.old.callback;
    const parameter = callback.params[0];
    if (!parameter) continue;
    const declarations = callback.body.body
      .filter((statement) => statement.type === 'VariableDeclaration')
      .flatMap((statement) => statement.declarations);
    for (const declaration of declarations) {
      const call = declaration.init?.type === 'AwaitExpression' && declaration.init.argument;
      if (
        declaration.id.type === 'ObjectPattern' &&
        call?.type === 'CallExpression' &&
        call.arguments.length === 1 &&
        call.arguments[0]?.type === 'Identifier' &&
        call.arguments[0].name === parameter.name
      )
        mixed.recognizedIdentifiers.add(call.arguments[0]);
    }
  }
}
function analyzeEachUnselectedFixture(args) {
  const individual = args.selected.map((item) => analyzeUnselectedFixtureSlice({ ...args, selected: [item] }));
  const supported = individual.map((item) => item.fixtures.length > 0 && item.isolatedIdentifiers.size > 0);
  const results = individual.filter((_, index) => supported[index]);
  if (supported.some((value) => !value)) {
    const anchor = args.selected.find((_, index) => supported[index])?.old;
    if (!anchor) return analyzeUnselectedFixtureSlice(args);
    const selected = args.selected.filter((_, index) => !supported[index]);
    const mixed = analyzeMixedPlainRendererSlice({ ...args, anchor, selected });
    if (!mixed.mixedRegionCertificate) return analyzeUnselectedFixtureSlice(args);
    addMixedContextIdentifiers(selected, mixed);
    results.push(mixed);
  }
  if (!results.length) return analyzeUnselectedFixtureSlice(args);
  const merge = (key) => new Set(results.flatMap((item) => [...item[key]]));
  const dependencies = new Map();
  for (const item of results.flatMap((result) => result.dependencies)) {
    check(
      !dependencies.has(item.path) || jsonHash(dependencies.get(item.path)) === jsonHash(item),
      'generated-fixture-source-changed',
    );
    dependencies.set(item.path, item);
  }
  return {
    recognizedIdentifiers: merge('recognizedIdentifiers'),
    isolatedIdentifiers: merge('isolatedIdentifiers'),
    recognizedBuiltinImports: merge('recognizedBuiltinImports'),
    handledInputSources: merge('handledInputSources'),
    dependencies: [...dependencies.values()],
    fixtures: results.flatMap((item) => item.fixtures),
  };
}

function analyzeEachRoutingInput(file, oldModel, currentModel) {
  const specs = (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests ?? []);
  check(specs.length > 0, 'unsupported-loopback-fixture-slice');
  const results = specs.map((spec) =>
    analyzeRoutingInputSlice({
      baselineAst: oldModel.ast,
      currentAst: currentModel.ast,
      selected: [
        {
          old: oldModel.registrations.find((row) => row.id === spec.baselineId),
          current: registration(currentModel, spec),
        },
      ],
      implementationSources: (file.importRoles ?? [])
        .filter((role) => role.role === 'implementation-under-test')
        .map((role) => role.source),
    }),
  );
  const first = results[0];
  for (const result of results) {
    for (const key of [
      'oldSuite',
      'currentSuite',
      'oldBefore',
      'currentBefore',
      'oldAfter',
      'currentAfter',
      'addedDeclaration',
    ])
      check(result.normalization[key] === first.normalization[key], 'unsupported-loopback-fixture-slice');
  }
  for (const side of ['old', 'current']) {
    for (const key of ['recognizedIdentifiers', 'recognizedBuiltinImports', 'recognizedExternalInputs'])
      first[side][key] = new Set(results.flatMap((result) => [...result[side][key]]));
  }
  first.routingLoops = results.flatMap((result) => result.routing.loops);
  return first;
}

function memoryContextCertificate(currentModel, spec, assertion, preview, implementationSources) {
  const currentRow = registration(currentModel, spec);
  const baselineView = {
    ...currentModel,
    registrations: currentModel.registrations.map((row) =>
      row === currentRow ? { ...row, id: spec.baselineId } : row,
    ),
  };
  const replacement = [...(preview?.replacements ?? [])].find(
    ([candidate, previous]) =>
      currentRow.assertions.some((item) => item.node === candidate) && parityAstHash(previous) === assertion.sha256,
  );
  return certifyMemoryContextSlice({
    baselineModel: baselineView,
    currentModel,
    baselineId: spec.baselineId,
    assertionSha256: replacement ? parityAstHash(replacement[0]) : assertion.sha256,
    implementationSources,
  });
}
function selectedSliceInputs(file, oldModel, currentModel) {
  const specs = (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests ?? []);
  const oldSelected = specs.map((spec) => ({
    old: oldModel.registrations.find((row) => row.id === spec.baselineId),
  }));
  check(
    oldSelected.every((item) => item.old),
    'stale-baseline-id',
  );
  return {
    specs,
    oldSelected,
    currentSelected: specs.map((spec) => ({ old: registration(currentModel, spec) })),
    implementationSources: (file.importRoles ?? [])
      .filter((role) => role.role === 'implementation-under-test')
      .map((role) => role.source),
  };
}
function preserveExistingCase(prior, next) {
  check(prior.length === 1 && next.length === 1, 'existing-case-definition-omitted');
  const old = prior[0],
    current = next[0];
  for (const [key, value] of Object.entries(old)) {
    if (key === 'proofs' || key === 'caseSelection') continue;
    check(Object.hasOwn(current, key) && jsonHash(value) === jsonHash(current[key]), 'existing-case-binding-changed');
  }
  check(current.caseSelection, 'existing-case-definition-omitted');
  for (const [key, value] of Object.entries(old.caseSelection))
    if (key !== 'selected')
      check(jsonHash(value) === jsonHash(current.caseSelection[key]), 'existing-case-binding-changed');
  const priorSelections = old.caseSelection.selected.map(jsonHash);
  const newSelections = new Set(current.caseSelection.selected.map(jsonHash));
  check(
    priorSelections.every((item) => newSelections.has(item)),
    'existing-case-fact-mapping-omitted',
  );
  const newProofs = new Set(current.proofs.map(jsonHash));
  check(
    old.proofs.every((proof) => newProofs.has(jsonHash(proof))),
    'existing-case-proof-omitted',
  );
}
function preserveCorrectedPartial(old, current, candidateCorrections) {
  if (!candidateCorrections?.size) return false;
  const corrections = new Map(
    [...candidateCorrections].map(([nextNode, oldNode]) => [parityAstHash(oldNode), parityAstHash(nextNode)]),
  );
  const expectedAssertions = old.originalAssertions.map((hash) => corrections.get(hash) ?? hash);
  const ignored = new Set([
    'originalAssertions',
    'originalBodyAstSha256',
    'moduleContextAstSha256',
    'proofs',
    'moduleReview',
    'regionHashes',
    'regionFactIds',
  ]);
  const preserved = Object.entries(old).every(
    ([key, value]) => ignored.has(key) || (Object.hasOwn(current, key) && jsonHash(value) === jsonHash(current[key])),
  );
  if (!(
    preserved &&
    jsonHash(current.baselineOriginalAssertions) === jsonHash(old.originalAssertions) &&
    jsonHash(current.originalAssertions) === jsonHash(expectedAssertions) &&
    old.proofs.length > 0 &&
    old.proofs.every((proof, i) => jsonHash(proof) === jsonHash(current.proofs[i]))
  ))
    return false;
  for (const [hashes, i] of old.regionHashes.map((hashes, i) => [hashes, i]))
    check(
      current.regionHashes.some(
        (nextHashes, j) =>
          jsonHash([nextHashes, current.regionFactIds[j]]) === jsonHash([hashes, old.regionFactIds[i]]),
      ),
      'existing-partial-region-omitted',
    );
  return true;
}
function preserveExistingPartial(prior, next, candidateCorrections = null) {
  for (const old of prior) {
    const index = next.findIndex((item) => item.baselineId === old.baselineId);
    let current = next[index];
    check(current, 'existing-partial-definition-omitted');
    // When a cohort grows, retain an unchanged existing region and its already
    // validated descriptor verbatim. The new cohort may add fixture certificates,
    // but it cannot alter or omit any of the original certificates or bindings.
    const withoutFixtures = ({ generatedFixtures: _fixtures, moduleReview: _review, ...rest }) => rest;
    if (
      jsonHash(withoutFixtures(old)) === jsonHash(withoutFixtures(current)) &&
      Array.isArray(old.generatedFixtures) &&
      Array.isArray(current.generatedFixtures) &&
      old.generatedFixtures.every((fixture) =>
        current.generatedFixtures.some((candidate) => jsonHash(fixture) === jsonHash(candidate)),
      )
    ) {
      next[index] = old;
      current = old;
    }
    if (preserveCorrectedPartial(old, current, candidateCorrections)) continue;
    for (const [key, value] of Object.entries(old)) {
      if (['regionHashes', 'regionFactIds'].includes(key)) continue;
      check(
        Object.hasOwn(current, key) && jsonHash(value) === jsonHash(current[key]),
        'existing-partial-binding-changed',
      );
    }
    const oldRegions = old.regionHashes.map((hashes, i) => jsonHash([hashes, old.regionFactIds[i]]));
    const newRegions = new Set(current.regionHashes.map((hashes, i) => jsonHash([hashes, current.regionFactIds[i]])));
    check(
      oldRegions.every((region) => newRegions.has(region)),
      'existing-partial-region-omitted',
    );
  }
}
function explicitFallback(file, oldModel, currentModel) {
  if (file.fallbackKind === undefined) return false;
  const hasTag = (source) => /^[ \t]*\/\/\s*@test-kind\b/mu.test(source);
  check(
    file.fallbackKind === 'unproven' &&
      typeof file.fallbackReason === 'string' &&
      file.fallbackReason.length >= 20 &&
      !/[\r\n]/u.test(file.fallbackReason),
    'explicit-unproven-fallback-required',
  );
  check(!hasTag(oldModel.source) && !hasTag(currentModel.source), 'fallback-would-change-existing-kind');
  check(Array.isArray(file.fallbackUnselectedBaselineIds), 'explicit-unselected-baseline-ids-required');
  return true;
}

function publicProof(proof, context) {
  const prepared = context.prepared.get(proof);
  if (prepared) return prepared.portableProof;
  const allowed = new Set(['path', 'sha256', 'mode', 'capturePointers', 'package', 'packagePointer', 'facts']);
  const factKeys = new Set(['id', 'pointer', 'sha256', 'replicatedPointers', 'equalBodyHashesPointer']);
  return Object.fromEntries(
    Object.entries(proof)
      .filter(([key]) => allowed.has(key))
      .map(([key, value]) => [
        key,
        key === 'facts'
          ? value.map((fact) =>
              Object.fromEntries(
                Object.entries(fact).filter(
                  ([name, item]) =>
                    factKeys.has(name) &&
                    (name !== 'equalBodyHashesPointer' ||
                      (typeof item === 'string' && /^\/cases\/\d+\/nativeBodySha256$/u.test(item))),
                ),
              ),
            )
          : value,
      ]),
  );
}
function validateCaseMigrationInput(root, file, candidate, dependencies) {
  const scopes = require('eslint-scope').analyze(candidate.ast, { ecmaVersion: 2022, sourceType: 'module' });
  const references = new Map();
  for (const scope of scopes.scopes) for (const ref of scope.references) references.set(ref.identifier, ref.resolved);
  const fsImports = candidate.ast.body.filter(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.source.value === 'node:fs' &&
      node.specifiers.length === 1 &&
      node.specifiers[0].type === 'ImportDefaultSpecifier' &&
      node.specifiers[0].local.name === 'fs',
  );
  check(fsImports.length === 1, 'unsupported-case-migration-input');
  function scan(node, ancestors = []) {
    if (node.type === 'Identifier' && node.name === 'fs') {
      const parent = ancestors.at(-1),
        grandparent = ancestors.at(-2);
      if (parent?.type !== 'ImportDefaultSpecifier') {
        const call = grandparent,
          url = call?.arguments?.[0],
          meta = url?.arguments?.[1];
        check(
          references.get(node)?.defs?.length === 1 &&
            references.get(node).defs[0].parent === fsImports[0] &&
            parent?.type === 'MemberExpression' &&
            parent.object === node &&
            !parent.computed &&
            parent.property.name === 'readFileSync' &&
            call?.type === 'CallExpression' &&
            call.callee === parent &&
            call.arguments.length === 1 &&
            url?.type === 'NewExpression' &&
            url.callee?.name === 'URL' &&
            references.has(url.callee) &&
            !references.get(url.callee) &&
            url.arguments.length === 2 &&
            url.arguments[0]?.type === 'Literal' &&
            typeof url.arguments[0].value === 'string' &&
            url.arguments[0].value.startsWith('./') &&
            !/[?#\\]/u.test(url.arguments[0].value) &&
            meta?.type === 'MemberExpression' &&
            !meta.computed &&
            meta.property.name === 'url' &&
            meta.object.type === 'MetaProperty' &&
            meta.object.meta.name === 'import' &&
            meta.object.property.name === 'meta',
          'unsupported-case-migration-input',
        );
        const relative = path
          .relative(root, path.resolve(root, path.dirname(file.path), url.arguments[0].value))
          .replaceAll(path.sep, '/');
        check(
          dependencies.some((item) => item.path === relative),
          'case-migration-evidence-set',
        );
      }
    }
    childNodes(node).forEach((child) => scan(child, [...ancestors, node]));
  }
  scan(candidate.ast);
}
function caseMigrationFacts(root, file, proofContext) {
  const allFacts = new Map();
  for (const guarantee of file.guarantees ?? [])
    for (const proof of guarantee.proofs ?? []) {
      prove(root, proof, proofContext);
      const capsule = JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8'));
      for (const fact of proof.facts ?? []) {
        check(!allFacts.has(fact.id), 'ambiguous-fact-id');
        allFacts.set(fact.id, pointer(capsule, fact.pointer));
      }
    }
  return allFacts;
}
function verifyCaseMigrationSelectedFacts(tests, verified, allFacts) {
  const bindings = tests[0].caseUniverse.currentCaseBindings;
  check(Array.isArray(bindings) && bindings.length === verified.rows.length, 'case-migration-bindings-required');
  for (const item of tests[0].caseSelection.selected) {
    const row = verified.rows[item.caseIndex],
      values = Object.values(bindings[item.caseIndex] ?? {});
    check(
      row &&
        values.length === 2 &&
        typeof values[0] === 'string' &&
        parityHash(values[0]) === row.expressionSha256 &&
        jsonHash(values[1]) === jsonHash(row.candidateValue) &&
        Array.isArray(item.factIds) &&
        item.factIds.length &&
        item.factIds.every((id) => {
          const fact = allFacts.get(id);
          return (
            fact &&
            fact.expression === values[0] &&
            fact.kind === 'value' &&
            jsonHash(fact.value) === jsonHash(values[1])
          );
        }),
      'case-migration-fact-mismatch',
    );
  }
}
function verifyCaseMigrationReviewFacts(request, tests, verified, allFacts) {
  for (const reviewed of [
    request.review,
    request.review.matrixBinding,
    ...request.review.partitions,
    ...request.review.moduleReplacements,
    ...request.review.moduleAdditions,
    ...request.review.assertionReplacements,
    ...request.review.assertionAdditions,
    ...request.review.retainedRegistrations,
    ...request.review.mustRetainAssertions,
  ])
    check(
      Array.isArray(reviewed?.factIds) &&
        reviewed.factIds.length > 0 &&
        reviewed.factIds.every((id) => allFacts.has(id)),
      'case-migration-review-fact-required',
    );
  for (const correction of request.review.corrections) {
    if (!verified.selectedIndices.includes(correction.caseIndex)) continue;
    const selected = tests[0].caseSelection.selected.find((item) => item.caseIndex === correction.caseIndex);
    check(
      correction.factIds.every((id) => selected.factIds.includes(id)),
      'case-correction-proof-required',
    );
  }
}
function prepareCaseBodyMigration(root, file, baselineSource, currentSource, caseCandidateFile, proofContext) {
  const request = file.caseBodyMigration;
  if (!request) return null;
  check(caseCandidateFile && request.review && Array.isArray(request.evidenceSources), 'case-migration-input-required');
  const candidateSource = fs.readFileSync(caseCandidateFile, 'utf8');
  const evidence = {},
    dependencies = [];
  for (const item of request.evidenceSources) {
    check(
      typeof item.id === 'string' && ID.test(item.id) && !Object.hasOwn(evidence, item.id) && SHA.test(item.sha256),
      'invalid-case-migration-evidence',
    );
    const absolute = requirePublicCdnPath(root, item.path, null, true),
      bytes = fs.readFileSync(absolute);
    check(parityHash(bytes) === item.sha256, 'changed-test-input-dependency');
    evidence[item.id] = bytes;
    dependencies.push({ path: item.path, sha256: item.sha256 });
  }
  const verified = verifyCaseMigration({
    baselineSource,
    currentSource,
    candidateSource,
    review: request.review,
    evidence,
  });
  check(
    jsonHash(Object.keys(verified.evidenceHashes).sort(compareCodeUnits)) ===
      jsonHash(Object.keys(evidence).sort(compareCodeUnits)),
    'case-migration-evidence-set',
  );
  const candidate = describeParitySource(candidateSource, file.path);
  validateCaseMigrationInput(root, file, candidate, dependencies);
  const tests = (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests ?? []);
  check(
    tests.length === 1 &&
      tests[0].caseSelection &&
      jsonHash(tests[0].caseSelection.selected.map((item) => item.caseIndex)) === jsonHash(verified.selectedIndices),
    'invalid-selected-case-path',
  );
  const allFacts = caseMigrationFacts(root, file, proofContext);
  verifyCaseMigrationSelectedFacts(tests, verified, allFacts);
  verifyCaseMigrationReviewFacts(request, tests, verified, allFacts);
  return { candidateSource, verified, dependencies };
}
function receiptDestination(root, relative) {
  const destination = confined(root, relative),
    parent = fs.realpathSync(path.dirname(destination));
  const rootReal = fs.realpathSync(root),
    relativeParent = path.relative(rootReal, parent);
  check(
    relativeParent !== '..' && !relativeParent.startsWith('..' + path.sep) && !path.isAbsolute(relativeParent),
    'symlink-outside-root',
  );
  return destination;
}
/** Pure preflight: no writes, no execution of project modules or proof payloads. */
function verifyRecordsReviewedContext(root, file, oldModel, review, reviewedSourceFile) {
  check(reviewedSourceFile, 'records-reviewed-source-required');
  const reviewedSource = fs.readFileSync(reviewedSourceFile, 'utf8');
  check(parityHash(reviewedSource) === review.source.sha256, 'records-review-required');
  assertParityBindingsFromSource(pathToFileURL(path.resolve(root, file.path)));
  // Later additive qualifications may introduce region blocks. Validate the
  // complete source guard and every matching wrapper before removing only
  // that generated scaffolding for comparison with the reviewed source.
  const diskModel = describeParitySource(fs.readFileSync(path.resolve(root, file.path), 'utf8'), file.path);
  const unwrapped = unwrapExistingPartial(root, file, diskModel.source, diskModel, oldModel);
  const normalized = unwrapped ? describeParitySource(unwrapped.source, file.path) : diskModel;
  const ignored = new Set();
  for (const node of normalized.ast.body)
    if (node.type === 'ImportDeclaration' && node.specifiers.some((part) => part.local.name === RECORDS_IMPORT))
      ignored.add(node);
  for (const row of normalized.registrations)
    for (const statement of row.callback.body?.body ?? [])
      if (statement.type === 'ExpressionStatement' && statement.expression?.callee?.name === RECORDS_IMPORT)
        ignored.add(statement);
  check(
    ignored.size === 7 + (unwrapped?.descriptors.length ?? 0) &&
      (unwrapped?.descriptors ?? []).every((descriptor) => descriptor.recordsFixture),
    'records-marker-set-changed',
  );
  const reviewed = describeParitySource(reviewedSource, file.path);
  const originalGuards = new Set(
    oldModel.registrations.flatMap((row) => row.assertions.filter(isHashGuard).map((item) => item.sha256)),
  );
  check(
    moduleContextHash(reviewed, { originalGuards }) === moduleContextHash(normalized, { ignored, originalGuards }),
    'records-reviewed-context-changed',
  );
}

function verifyRecordsMapping(root, oldModel, currentHashes, mapping) {
  const old = oldModel.registrations.find((row) => row.id === mapping.originalId);
  const expected = [
    ...mapping.retainedOriginalAssertions,
    ...mapping.correctedOriginalAssertions.map((item) => item.before),
  ];
  check(
    old?.assertions.length === expected.length && old.assertions.every((item) => expected.includes(item.sha256)),
    'records-review-required',
  );
  check(
    mapping.retainedOriginalAssertions.every((hash) => currentHashes.has(hash)),
    'records-review-required',
  );
  for (const correction of mapping.correctedOriginalAssertions) {
    check(currentHashes.has(correction.after) && SHA.test(correction.evidence.sha256), 'records-review-required');
    const evidence = path.resolve(correction.evidence.path);
    check(
      evidence === confined(root, path.relative(root, evidence)) &&
        parityHash(fs.readFileSync(evidence)) === correction.evidence.sha256,
      'records-review-required',
    );
  }
}

function verifyRecordsReview(root, file, oldModel, currentModel, reviewFile, reviewedSourceFile) {
  check(reviewFile && file.path === 'mirage/test/dataverse-records.test.mjs', 'records-review-required');
  const bytes = fs.readFileSync(reviewFile);
  check(
    parityHash(bytes) === '5a7fcbf242941cfa2b97c8baa9316402b821f33b1f0a7a7c7742b8fbd0ef09e7',
    'records-review-required',
  );
  const review = JSON.parse(bytes);
  check(
    oldModel.sourceSha256 === 'ff38793a7a03a6ef4089ee1079e862d1379e18e5f935773fbe9d376481ed7519' &&
      review.status === 'accepted-exact-current-bindings-for-additive-records-guard-migration' &&
      review.newWhole === 0 &&
      review.newCases === 0 &&
      review.originalMapping.length === 2,
    'records-review-required',
  );
  if (review.source.sha256 !== currentModel.sourceSha256)
    verifyRecordsReviewedContext(root, file, oldModel, review, reviewedSourceFile);
  const expectedIds = [
    'mirage/test/dataverse-records.test.mjs:2000:0',
    'mirage/test/dataverse-records.test.mjs:2193:0',
  ];
  check(
    jsonHash(review.originalMapping.map((item) => item.originalId)) === jsonHash(expectedIds),
    'records-review-required',
  );
  const currentHashes = new Set(currentModel.registrations.flatMap((row) => row.assertions.map((item) => item.sha256)));
  for (const mapping of review.originalMapping) verifyRecordsMapping(root, oldModel, currentHashes, mapping);
  return parityHash(bytes);
}

function queryMatrixSourceTypes(old, oldModel) {
  const schemaNodes = old.parent.callback.body.body.flatMap((statement) => {
    const assignment = statement.type === 'ExpressionStatement' && statement.expression;
    return assignment?.type === 'AssignmentExpression' &&
      assignment.operator === '=' &&
      assignment.right?.type === 'ObjectExpression' &&
      assignment.right.properties.some((property) => (property.key?.name ?? property.key?.value) === 'fields') &&
      assignment.right.properties.some((property) => (property.key?.name ?? property.key?.value) === 'idColumn')
      ? [assignment.right]
      : [];
  });
  check(schemaNodes.length === 1, 'unsupported-query-matrix');
  const prop = (object, name) =>
    object?.properties?.find((item) => !item.computed && (item.key.name ?? item.key.value) === name)?.value;
  const id = prop(schemaNodes[0], 'idColumn'),
    fields = prop(schemaNodes[0], 'fields');
  check(
    id?.type === 'Literal' && typeof id.value === 'string' && fields?.type === 'ObjectExpression',
    'unsupported-query-matrix',
  );
  const typeNames = {
    nvarchar: 'Edm.String',
    int: 'Edm.Int32',
    bit: 'Edm.Boolean',
    datetime: 'Edm.DateTimeOffset',
    lookup: 'Edm.Guid',
  };
  const sourceTypes = { [id.value]: 'Edm.Guid' };
  const seededRows = old.parent.callback.body.body.flatMap((statement) => {
    const assignment = statement.type === 'ExpressionStatement' && statement.expression;
    return assignment?.type === 'AssignmentExpression' &&
      assignment.right?.type === 'ArrayExpression' &&
      assignment.right.elements.length === 1 &&
      assignment.right.elements[0]?.type === 'ObjectExpression' &&
      prop(assignment.right.elements[0], id.value)
      ? [assignment.right.elements[0]]
      : [];
  });
  check(seededRows.length === 1, 'unsupported-query-matrix');
  const sourceId = prop(seededRows[0], id.value);
  const sourceIdDeclarations = oldModel.ast.body.flatMap((statement) =>
    statement.type === 'VariableDeclaration' && statement.kind === 'const'
      ? statement.declarations.filter(
          (entry) =>
            entry.id?.name === sourceId?.name && entry.init?.type === 'Literal' && typeof entry.init.value === 'string',
        )
      : [],
  );
  check(
    sourceId?.type === 'Identifier' &&
      sourceIdDeclarations.length === 1 &&
      /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/u.test(
        sourceIdDeclarations[0].init.value,
      ),
    'unsupported-query-matrix',
  );
  for (const field of fields.properties) {
    const name = field.key?.name ?? field.key?.value,
      type = prop(field.value, 'dataverseType')?.value;
    check(
      typeof name === 'string' && typeof type === 'string' && Object.hasOwn(typeNames, type),
      'unsupported-query-matrix',
    );
    sourceTypes[name] = typeNames[type];
  }
  return sourceTypes;
}

function verifyPriorQueryFacts(root, previous, selected, prior) {
  for (const index of previous.selectedIndices) {
    const item = selected.find((entry) => entry.caseIndex === index);
    const priorIds = prior[0].proofs.flatMap((proof) => {
      const capsule = JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8'));
      return (capsule.captures?.[0]?.cases ?? []).flatMap((entry, position) =>
        entry.caseIndex === index
          ? [
              [
                'facts/status',
                'facts/code',
                'facts/message',
                ...(entry.originalSdkMessages ? ['originalSdkMessages', 'adaptedSdkMessages', 'sourceRoles'] : []),
              ].map(
                (suffix) => proof.facts.find((fact) => fact.pointer === `/captures/0/cases/${position}/${suffix}`)?.id,
              ),
            ]
          : [],
      );
    });
    check(priorIds.length === 1 && jsonHash(priorIds[0]) === jsonHash(item.factIds), 'existing-query-fact-changed');
  }
}

function verifyCandidateQueryEvidence(candidates, file, spec, titles, old) {
  for (const { proof, capsule } of candidates)
    check(
      proof.mode === 'reproduced-native' &&
        ((capsule.source?.sourceSha256 === file.baselineSha256 &&
          capsule.source.titleExpressionSha256 === spec.titleExpressionSha256 &&
          capsule.source.caseUniverseSha256 === jsonHash(titles) &&
          (SHA.test(capsule.source.primaryKeyRoleCertificateSha256) ||
            SHA.test(capsule.source.typedRoleCertificateSha256)) &&
          jsonHash(capsule.source.originalAssertionSha256) === jsonHash(old.assertions.map((item) => item.sha256))) ||
          (capsule.source?.baselineSha256 === file.baselineSha256 &&
            SHA.test(capsule.source.originalSdkSha256) &&
            SHA.test(capsule.source.adaptedSdkSha256))) &&
        capsule.captures?.length === 2 &&
        capsule.captures[0].runSha256 !== capsule.captures[1].runSha256,
      'unsupported-query-evidence',
    );
}

function verifyQueryCaptureRounds(capsule, bridged, position, binding, item) {
  for (let run = 0; run < 2; run++) {
    const capture = capsule.captures[run],
      entry = capture.cases?.[position],
      expected = binding[item.caseIndex];
    check(
      SHA.test(capture.runSha256) &&
        SHA.test(capture.metadataSha256) &&
        SHA.test(capture.csdlSha256) &&
        entry?.caseIndex === item.caseIndex &&
        (bridged
          ? ['option', 'value', 'status', 'message'].every((key) => entry.sourceBinding?.[key] === expected[key])
          : jsonHash(entry.sourceBinding) === jsonHash(expected)) &&
        SHA.test(entry.requestSha256) &&
        SHA.test(entry.responseBodySha256) &&
        entry.facts?.status === expected.status &&
        (bridged ? entry.facts.message === entry.predictedNativeMessage : entry.facts.message === expected.message) &&
        entry.facts.code === (expected.status === 501 ? '0x8006088a' : '0x80060888'),
      'unsupported-query-evidence',
    );
  }
}

function verifyQueryFacetBindings({ item, proof, position, suffixes, used, spec }) {
  for (let facet = 0; facet < suffixes.length; facet++) {
    const id = item.factIds[facet],
      found = proof.facts.filter((entry) => entry.id === id),
      pointer = `/captures/0/cases/${position}/${suffixes[facet]}`,
      assertionIndex = Math.min(facet, 2),
      assertionFacts = assertionIndex === 2 ? item.factIds.slice(2) : [id];
    check(
      !used.has(id) &&
        found.length === 1 &&
        found[0].pointer === pointer &&
        jsonHash(found[0].replicatedPointers) ===
          jsonHash([pointer, `/captures/1/cases/${position}/${suffixes[facet]}`]) &&
        spec.regions.flatMap((region) => region.assertions)[assertionIndex].factIds?.includes(id) &&
        spec.caseFacts?.some(
          (entry) =>
            entry.caseIndex === item.caseIndex &&
            entry.assertionIndex === assertionIndex &&
            jsonHash(entry.factIds) === jsonHash(assertionFacts),
        ),
      'unsupported-query-fact-binding',
    );
    used.add(id);
  }
}

function verifySelectedQueryFacts({
  file,
  prior,
  selected,
  candidates,
  proofContext,
  binding,
  sourceTypes,
  spec,
  facets,
}) {
  const used = new Set();
  let bridgeAuthority;
  for (const item of selected) {
    const matches = candidates.flatMap((candidate) =>
      candidate.proof.facts.filter((fact) => fact.id === item.factIds[0]).map((fact) => ({ ...candidate, fact })),
    );
    check(matches.length === 1, 'unsupported-query-fact-binding');
    const { proof, capsule, fact } = matches[0],
      match = /^\/captures\/0\/cases\/(\d+)\/facts\/status$/u.exec(fact.pointer),
      position = match && Number(match[1]);
    check(match && Number.isSafeInteger(position), 'unsupported-query-fact-binding');
    const bridged = item.factIds.length === 6;
    if (bridged) {
      check(
        prior[0].queryBridgeAuthoritySha256 === file.queryBridgeWitness?.sha256 ||
          capsule.source.currentSha256 === file.currentSha256,
        'stale-query-bridge-source',
      );
      if (!bridgeAuthority)
        bridgeAuthority = verifyQueryMessageBridge({
          evidenceRoot: proofContext.evidenceRoot,
          witness: file.queryBridgeWitness,
          capsule,
          expectedSourceSha256: file.baselineSha256,
        });
      verifyQueryMessageBridgeCase(bridgeAuthority, capsule, item.caseIndex, binding[item.caseIndex], sourceTypes);
    }
    verifyQueryCaptureRounds(capsule, bridged, position, binding, item);
    const suffixes = bridged
      ? ['facts/status', 'facts/code', 'facts/message', 'originalSdkMessages', 'adaptedSdkMessages', 'sourceRoles']
      : facets.map((facet) => `facts/${facet}`);
    verifyQueryFacetBindings({ item, proof, position, suffixes, used, spec });
  }
  check(
    candidates.every(({ proof }) => proof.facts.every((fact) => used.has(fact.id))) &&
      used.size === selected.reduce((count, item) => count + item.factIds.length, 0),
    'unsupported-query-fact-binding',
  );
  return bridgeAuthority;
}

function extendQueryMatrix(root, file, before, oldModel, currentModel, proofContext) {
  const guarantee = file.guarantees?.[0],
    spec = guarantee?.tests?.[0];
  check(
    file.guarantees?.length === 1 &&
      guarantee.tests?.length === 1 &&
      guarantee.context?.authorResponsibility === true &&
      spec?.baselineId === 'mirage/test/dataverse-query-reader.test.mjs:187:10' &&
      Array.isArray(guarantee.proofs) &&
      guarantee.proofs.length,
    'unsupported-query-matrix',
  );
  const guard = currentModel.ast.body.filter(
    (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === QUERY_IMPORT,
  );
  const declarations = currentModel.ast.body.filter(
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.declarations.length === 1 &&
      node.declarations[0].id?.name === '__paqQueryDescriptor',
  );
  check(guard.length === 1 && declarations.length === 1, 'invalid-query-bindings');
  const call = guard[0].expression,
    prior = guardDescriptors({ ...call, callee: { type: 'Identifier', name: IMPORT } });
  assertQueryParityBindings(pathToFileURL(path.resolve(root, file.path)), prior);
  const dataCall = {
    ...call,
    callee: { type: 'Identifier', name: IMPORT },
    arguments: [call.arguments[0], { type: 'ArrayExpression', elements: [declarations[0].declarations[0].init] }],
  };
  const previous = guardDescriptors(dataCall)[0],
    old = oldModel.registrations.find((row) => row.id === spec.baselineId);
  check(
    old?.parent && old.assertions.length === 3 && old.titleExpressionSha256 === spec.titleExpressionSha256,
    'unsupported-query-matrix',
  );
  const cases = old.parent.callback.body.body.flatMap((node) =>
    node.type === 'VariableDeclaration' ? node.declarations.filter((item) => item.id?.name === 'cases') : [],
  );
  check(cases.length === 1, 'unsupported-query-matrix');
  const universe = queryUniverse(cases[0].init).map((item) => item.binding),
    binding = universe.map(([option, value, status, message]) => ({ option, value, status, message }));
  const sourceTypes = queryMatrixSourceTypes(old, oldModel);
  const titles = universe.map(([option, value]) => `${option} ${value}`),
    selected = spec.caseSelection?.selected;
  check(
    jsonHash(previous.universe) === jsonHash(universe) &&
      jsonHash(binding) === jsonHash(spec.caseUniverse.caseBindings) &&
      spec.caseUniverse.count === 63 &&
      jsonHash(titles) === jsonHash(spec.caseUniverse.cases) &&
      jsonHash(titles) === spec.caseUniverse.casesSha256 &&
      jsonHash(old.assertions.map((item) => item.sha256)) ===
        jsonHash(spec.regions.flatMap((region) => region.assertions.map((item) => item.sha256))) &&
      Array.isArray(selected) &&
      selected.length >= previous.selectedIndices.length &&
      selected.length <= 63 &&
      selected.every(
        (item, index) =>
          Number.isInteger(item.caseIndex) &&
          item.caseIndex >= 0 &&
          item.caseIndex < 63 &&
          (!index || selected[index - 1].caseIndex < item.caseIndex) &&
          Array.isArray(item.factIds) &&
          [3, 6].includes(item.factIds.length),
      ) &&
      previous.selectedIndices.every((index) => selected.some((item) => item.caseIndex === index)),
    'existing-query-case-omitted',
  );
  const facets = ['status', 'code', 'message'];
  verifyPriorQueryFacts(root, previous, selected, prior);
  const portable = guarantee.proofs.map((proof) => {
    prove(root, proof, proofContext);
    return publicProof(proof, proofContext);
  });
  check(
    prior[0].proofs.every((proof, index) => jsonHash(proof) === jsonHash(portable[index])),
    'existing-query-proof-changed',
  );
  const candidates = guarantee.proofs.map((proof) => ({
    proof,
    capsule: JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8')),
  }));
  verifyCandidateQueryEvidence(candidates, file, spec, titles, old);
  const bridgeAuthority = verifySelectedQueryFacts({
    root,
    file,
    prior,
    selected,
    candidates,
    proofContext,
    binding,
    sourceTypes,
    spec,
    facets,
  });
  const data = { ...previous, selectedIndices: selected.map((item) => item.caseIndex) },
    descriptor = {
      ...prior[0],
      queryDescriptorSha256: jsonHash(data),
      proofs: portable,
      ...(bridgeAuthority ? { queryBridgeAuthoritySha256: bridgeAuthority.authoritySha256 } : {}),
    };
  if (jsonHash(data) === jsonHash(previous) && jsonHash(portable) === jsonHash(prior[0].proofs))
    return { after: before, binding: prior[0], count: selected.length, added: 0 };
  const edits = [
    {
      start: declarations[0].declarations[0].init.range[0],
      end: declarations[0].declarations[0].init.range[1],
      text: JSON.stringify(data),
    },
    { start: call.arguments[1].range[0], end: call.arguments[1].range[1], text: JSON.stringify([descriptor]) },
  ];
  let after = before;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  return {
    after,
    binding: descriptor,
    count: selected.length,
    added: selected.length - previous.selectedIndices.length,
  };
}

function verifyInitialQueryFacts(proof, capsule, spec, binding) {
  const facets = ['status', 'code', 'message'];
  for (let position = 0; position < 5; position++) {
    const selected = spec.caseSelection.selected[position],
      expected = binding[selected.caseIndex];
    check(Array.isArray(selected.factIds) && selected.factIds.length === 3, 'unsupported-query-fact-binding');
    for (let run = 0; run < 2; run++) {
      const capture = capsule.captures[run],
        entry = capture.cases?.[position];
      check(
        SHA.test(capture.runSha256) &&
          SHA.test(capture.metadataSha256) &&
          SHA.test(capture.csdlSha256) &&
          entry?.caseIndex === selected.caseIndex &&
          jsonHash(entry.sourceBinding) === jsonHash(expected) &&
          SHA.test(entry.requestSha256) &&
          SHA.test(entry.responseBodySha256) &&
          entry.facts?.status === expected.status &&
          entry.facts.message === expected.message &&
          entry.facts.code === (expected.status === 501 ? '0x8006088a' : '0x80060888'),
        'unsupported-query-evidence',
      );
    }
    for (let facet = 0; facet < 3; facet++) {
      const id = selected.factIds?.[facet],
        found = proof.facts.filter((fact) => fact.id === id),
        pointer = `/captures/0/cases/${position}/facts/${facets[facet]}`;
      check(
        found.length === 1 &&
          spec.regions.flatMap((region) => region.assertions)[facet].factIds?.includes(id) &&
          found[0].pointer === pointer &&
          jsonHash(found[0].replicatedPointers) ===
            jsonHash([pointer, `/captures/1/cases/${position}/facts/${facets[facet]}`]),
        'unsupported-query-fact-binding',
      );
    }
  }
}
function qualifyQueryMatrix(root, file, before, oldModel, currentModel, proofContext) {
  const guarantee = file.guarantees?.[0],
    spec = guarantee?.tests?.[0],
    proof = guarantee?.proofs?.[0];
  check(
    file.guarantees?.length === 1 &&
      guarantee.tests?.length === 1 &&
      guarantee.proofs?.length === 1 &&
      guarantee.context?.authorResponsibility === true &&
      spec?.baselineId === 'mirage/test/dataverse-query-reader.test.mjs:187:10' &&
      parityHash(oldModel.source) === parityHash(before) &&
      proof.mode === 'reproduced-native',
    'unsupported-query-matrix',
  );
  const old = oldModel.registrations.find((row) => row.id === spec.baselineId),
    row = registration(currentModel, spec);
  check(
    old?.parent &&
      row.parent &&
      row.callback.async &&
      row.callback.params.length === 0 &&
      parityAstHash(old.callback) === parityAstHash(row.callback) &&
      old.assertions.length === 3 &&
      jsonHash(old.assertions.map((item) => item.sha256)) ===
        jsonHash(spec.regions.flatMap((region) => region.assertions.map((item) => item.sha256))),
    'unsupported-query-matrix',
  );
  const parent = row.parent.callback.body.body;
  const declarations = parent.flatMap((node) =>
    node.type === 'VariableDeclaration' ? node.declarations.filter((item) => item.id?.name === 'cases') : [],
  );
  const loops = parent.filter((node) => node.type === 'ForOfStatement' && node.right?.name === 'cases');
  check(
    declarations.length === 1 &&
      loops.length === 1 &&
      loops[0].body?.type === 'ExpressionStatement' &&
      loops[0].body.expression?.type === 'AwaitExpression' &&
      loops[0].body.expression.argument?.arguments?.[1] === row.callback,
    'unsupported-query-matrix',
  );
  const universe = queryUniverse(declarations[0].init).map((item) => item.binding);
  const binding = universe.map(([option, value, status, message]) => ({ option, value, status, message }));
  const titles = universe.map(([option, value]) => `${option} ${value}`);
  check(
    jsonHash(binding) === jsonHash(spec.caseUniverse.caseBindings) &&
      spec.caseUniverse.count === 63 &&
      jsonHash(titles) === jsonHash(spec.caseUniverse.cases) &&
      jsonHash(titles) === spec.caseUniverse.casesSha256 &&
      Array.isArray(spec.caseSelection?.selected) &&
      spec.caseSelection.selected.length === 5 &&
      spec.caseSelection.selected.every(
        (item, index, all) =>
          Number.isInteger(item.caseIndex) &&
          item.caseIndex >= 0 &&
          item.caseIndex < 63 &&
          (!index || all[index - 1].caseIndex < item.caseIndex),
      ),
    'unsupported-query-matrix',
  );
  prove(root, proof, proofContext);
  const capsule = JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8'));
  check(
    capsule.source?.sourceSha256 === file.baselineSha256 &&
      capsule.source.titleExpressionSha256 === spec.titleExpressionSha256 &&
      capsule.source.caseUniverseSha256 === jsonHash(titles) &&
      SHA.test(capsule.source.primaryKeyRoleCertificateSha256) &&
      jsonHash(capsule.source.originalAssertionSha256) === jsonHash(old.assertions.map((item) => item.sha256)) &&
      capsule.captures?.length === 2 &&
      proof.facts.length === 15,
    'unsupported-query-evidence',
  );
  verifyInitialQueryFacts(proof, capsule, spec, binding);
  check(
    capsule.captures[0].runSha256 !== capsule.captures[1].runSha256 &&
      ['__paqQueryIndex', '__paqQueryDescriptor', '__paqQueryCase', '__paqQueryComplete', QUERY_IMPORT].every(
        (name) => !currentModel.identifiers.has(name),
      ),
    'unsupported-query-matrix',
  );
  const descriptor = { universe, selectedIndices: spec.caseSelection.selected.map((item) => item.caseIndex) };
  const loop = loops[0],
    edits = [
      { start: loop.range[0], end: loop.range[0], text: 'let __paqQueryIndex = 0;\n' },
      {
        start: row.callback.body.body[0].range[0],
        end: row.callback.body.body[0].range[0],
        text: '__paqQueryCase(cases, __paqQueryIndex++, [option, value, status, message], __paqQueryDescriptor);\n',
      },
      {
        start: loop.range[1],
        end: loop.range[1],
        text: '\n__paqQueryComplete(__paqQueryIndex, __paqQueryDescriptor);',
      },
    ];
  let instrumented = before;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.end);
  const bindingDescriptor = {
    kind: 'query-reader-matrix-v1',
    repositoryRoot: path.relative(path.dirname(path.resolve(root, file.path)), root).replaceAll(path.sep, '/') || '.',
    sourceAstSha256: parityAstHash(parse(instrumented, { ecmaVersion: 'latest', sourceType: 'module' })),
    queryDescriptorSha256: jsonHash(descriptor),
    helperSha256: parityHash(fs.readFileSync(path.join(root, 'scripts/parity-query-universe.mjs'))),
    proofs: [publicProof(proof, proofContext)],
  };
  const relative = path.relative(path.dirname(path.resolve(root, file.path)), TOOL).replaceAll(path.sep, '/');
  const prefix = `// @test-kind unproven: remaining query reader cases retain local evidence only.\nimport { assertQueryParityBindings as ${QUERY_IMPORT}, assertQueryCase as __paqQueryCase, assertQueryCompletion as __paqQueryComplete } from ${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)};\nconst __paqQueryDescriptor = ${JSON.stringify(descriptor)};\n${QUERY_IMPORT}(import.meta.url, ${JSON.stringify([bindingDescriptor])});\n`;
  return { after: prefix + instrumented, binding: bindingDescriptor, descriptor };
}

function qualifySoapLoop(root, file, original, before, oldModel, currentModel, proofContext) {
  check(
    file.path === 'mirage/test/dataverse-soap-xml.test.mjs' && file.guarantees?.length === 1,
    'unsupported-assertion-loop',
  );
  const guarantee = file.guarantees[0],
    spec = guarantee.tests?.[0],
    proof = guarantee.proofs?.[0];
  check(
    guarantee.tests?.length === 1 &&
      guarantee.proofs?.length === 1 &&
      guarantee.context?.authorResponsibility === true &&
      proof.mode === 'official-package' &&
      spec?.assertionLoopSelection,
    'unsupported-assertion-loop',
  );
  prove(root, proof, proofContext);
  const old = oldModel.registrations.find((row) => row.id === spec.baselineId),
    current = registration(currentModel, spec);
  const capsule = JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8'));
  const analysis = analyzeAssertionLoop({
    baselineAst: oldModel.ast,
    currentAst: currentModel.ast,
    selected: { old, current },
    selection: spec.assertionLoopSelection,
    proof,
    capsule,
  });
  const body = current.callback.body.body,
    loop = body[0],
    setup = loop.body.body[0];
  check(
    loop.type === 'ForOfStatement' &&
      setup.type === 'VariableDeclaration' &&
      body.length === 3 &&
      [
        '__paqSoapDescriptor',
        '__paqSoapIndex',
        '__paqSoapValue',
        '__paqSoapComplete',
        '__paqSoapTail',
        SOAP_IMPORT,
      ].every((name) => !currentModel.identifiers.has(name)),
    'unsupported-assertion-loop',
  );
  const descriptor = analysis.descriptor,
    descText = JSON.stringify(descriptor);
  const edits = [
    { start: loop.range[0], end: loop.range[0], text: 'let __paqSoapIndex = 0;\n' },
    {
      start: setup.range[1],
      end: setup.range[1],
      text: '\n__paqSoapValue(VALUES, __paqSoapIndex++, value, xml, __paqSoapDescriptor);',
    },
    { start: loop.range[1], end: loop.range[1], text: '\n__paqSoapComplete(__paqSoapIndex, __paqSoapDescriptor);' },
  ];
  for (let index = 0; index < 2; index++) {
    const argument = body[index + 1].expression?.arguments?.[0]?.arguments?.[0];
    check(argument?.type === 'CallExpression' && argument.callee?.name === 'envelope', 'unsupported-assertion-loop');
    edits.push({
      start: argument.range[0],
      end: argument.range[1],
      text: `__paqSoapTail(${before.slice(...argument.range)}, ${index}, __paqSoapDescriptor)`,
    });
  }
  let instrumented = before;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.end);
  const helper = path.join(root, 'scripts/parity-assertion-loop.mjs'),
    relativeHelper = path.relative(path.dirname(path.resolve(root, file.path)), helper).replaceAll(path.sep, '/');
  const helperImport = `import { assertAssertionLoopValue as __paqSoapValue, assertAssertionLoopCompletion as __paqSoapComplete, assertAssertionTailXml as __paqSoapTail } from ${JSON.stringify(relativeHelper.startsWith('.') ? relativeHelper : './' + relativeHelper)};\n`;
  const data = `const __paqSoapDescriptor = ${descText};\n`;
  const sourceAstSha256 = parityAstHash(
    parse(helperImport + instrumented, { ecmaVersion: 'latest', sourceType: 'module' }),
  );
  const binding = {
    kind: 'soap-assertion-loop-v1',
    repositoryRoot: path.relative(path.dirname(path.resolve(root, file.path)), root).replaceAll(path.sep, '/') || '.',
    sourceAstSha256,
    loopDescriptorSha256: jsonHash(descriptor),
    helperSha256: parityHash(fs.readFileSync(helper)),
    proofs: [publicProof(proof, proofContext)],
  };
  const relative = path.relative(path.dirname(path.resolve(root, file.path)), TOOL).replaceAll(path.sep, '/');
  const headerEnd = instrumented.indexOf('\n') + 1;
  check(
    headerEnd > 0 && instrumented.slice(0, headerEnd).includes('@test-kind compatibility'),
    'unsupported-assertion-loop',
  );
  const header = instrumented.slice(0, headerEnd);
  instrumented = instrumented.slice(headerEnd);
  const after =
    header +
    helperImport +
    `import { assertSoapParityBindings as ${SOAP_IMPORT} } from ${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)};\n` +
    data +
    `${SOAP_IMPORT}(import.meta.url, ${JSON.stringify([binding])});\n` +
    instrumented;
  return { after, binding, descriptor };
}

function qualifyScalarMigration(root, file, original, before, proofContext) {
  check(
    file.path === 'mirage/test/dataverse-scalar-reader-http.test.mjs' && file.guarantees?.length === 1,
    'unsupported-scalar-migration',
  );
  const guarantee = file.guarantees[0],
    spec = guarantee.tests?.[0];
  check(
    guarantee.tests?.length === 1 &&
      spec?.baselineId === 'mirage/test/dataverse-scalar-reader-http.test.mjs:133:12' &&
      guarantee.context?.authorResponsibility === true &&
      guarantee.proofs?.length === 1,
    'unsupported-scalar-migration',
  );
  const producerPath = 'mirage/testing/webapi-contract.mjs',
    fixturePath = 'mirage/test/fixtures/webapi-native-scalar-reader.json';
  const producer = fs.readFileSync(confined(root, producerPath), 'utf8'),
    fixtureBytes = fs.readFileSync(confined(root, fixturePath));
  const producerSha256 = parityHash(producer),
    fixtureSha256 = parityHash(fixtureBytes);
  const existingFixture = JSON.parse(fixtureBytes);
  const migration = verifyScalarMigration({
    baselineSource: original,
    currentSource: before,
    producerSource: producer,
    capsule: existingFixture,
  });
  const proof = guarantee.proofs[0];
  prove(root, proof, proofContext);
  const capsule = JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8'));
  const assertions = spec.regions.flatMap((region) => region.assertions),
    expectedHashes = [
      '8c8ceb0a0347e2bb42f0a374c5be9674d12a1f76a01648c62ebf83ccf316140e',
      'a4a8bd9b7395a1bb3798960f3bac7132b49ec83f7aeaa1cdb62021d6dc52bcf2',
      'a5dbc679d5ad1d71275d1e60ce3259f4aef1aee476955c36192f6eaf410e75c7',
      '4cf7e9b580ee90b5ef07539afeaf1a271b0880e1c2f33db2d45c25815e78bea6',
    ];
  check(
    capsule.schemaVersion === 2 &&
      capsule.source?.baselineSha256 === file.baselineSha256 &&
      capsule.source.currentSha256 === file.currentSha256 &&
      capsule.source.tupleProducerSha256 === producerSha256 &&
      capsule.source.existingFixtureSha256 === fixtureSha256 &&
      jsonHash(capsule.source.originalAssertionSha256) === jsonHash(expectedHashes) &&
      jsonHash(assertions.map((item) => item.sha256)) === jsonHash(expectedHashes) &&
      spec.caseUniverse?.count === 68 &&
      proof.mode === 'reproduced-native' &&
      proof.facts.length === 272 &&
      capsule.captures?.length === 2,
    'unsupported-scalar-evidence',
  );
  const facets = ['status', 'code', 'cause', 'entityPositionMatchesRequestRole'];
  for (let index = 0; index < 68; index++) {
    const expected = migration.expected[index];
    for (let run = 0; run < 2; run++) {
      const capture = capsule.captures[run],
        entry = capture.cases?.[index],
        directive = entry?.sourceDirective;
      check(
        SHA.test(capture.runSha256) &&
          SHA.test(capture.metadataSha256) &&
          entry?.id === expected.id &&
          directive?.field === expected.field &&
          directive.token === expected.token &&
          directive.encoding === expected.encoding &&
          directive.method === expected.method &&
          directive.originalCaseIndex === index &&
          ['requestSha256', 'requestBodySha256', 'planCaseSha256', 'responseBodySha256'].every((key) =>
            SHA.test(entry[key]),
          ) &&
          entry.responseBodySha256 === existingFixture.cases[index].nativeBodySha256[run] &&
          entry.facts?.status === 400 &&
          entry.facts.code === '0x80048d19' &&
          entry.facts.cause === expected.cause &&
          entry.facts.entityPositionMatchesRequestRole === true,
        'unsupported-scalar-evidence',
      );
    }
    for (let facet = 0; facet < 4; facet++) {
      const id = `scalar-${index}-${facet}`,
        matching = proof.facts.filter((fact) => fact.id === id);
      check(
        matching.length === 1 &&
          assertions[facet].factIds?.includes(id) &&
          assertions[facet].factIds.length === 68 &&
          matching[0].pointer === `/captures/0/cases/${index}/facts/${facets[facet]}` &&
          jsonHash(matching[0].replicatedPointers) ===
            jsonHash([matching[0].pointer, `/captures/1/cases/${index}/facts/${facets[facet]}`]),
        'unsupported-scalar-fact-binding',
      );
    }
  }
  check(
    capsule.captures[0].runSha256 !== capsule.captures[1].runSha256 &&
      !describeParitySource(before).identifiers.has(SCALAR_IMPORT),
    'unsupported-scalar-evidence',
  );
  const descriptor = {
    kind: 'scalar-reader-migration-v1',
    repositoryRoot: path.relative(path.dirname(path.resolve(root, file.path)), root).replaceAll(path.sep, '/') || '.',
    sourceAstSha256: parityAstHash(parse(before, { ecmaVersion: 'latest', sourceType: 'module' })),
    producerPath,
    producerSha256,
    fixturePath,
    fixtureSha256,
    helperSha256: parityHash(fs.readFileSync(path.join(root, 'scripts/parity-scalar-migration.mjs'))),
    proofs: guarantee.proofs.map((item) => publicProof(item, proofContext)),
  };
  const relative = path.relative(path.dirname(path.resolve(root, file.path)), TOOL).replaceAll(path.sep, '/');
  const headerEnd = before.indexOf('\n') + 1;
  check(headerEnd > 0 && before.slice(0, headerEnd).includes('@test-kind contract'), 'unsupported-scalar-migration');
  const after =
    before.slice(0, headerEnd) +
    `import { assertScalarParityBindings as ${SCALAR_IMPORT} } from ${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)};\n${SCALAR_IMPORT}(import.meta.url, ${JSON.stringify([descriptor])});\n` +
    before.slice(headerEnd);
  return { after, descriptor };
}

function stripMigratedCaseMarker(node) {
  if (Array.isArray(node))
    return node
      .filter((item) => !(item?.type === 'ExpressionStatement' && item.expression?.callee?.name === CASE_IMPORT))
      .map(stripMigratedCaseMarker);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, stripMigratedCaseMarker(value)]));
}

function validateMigratedGuarantee(file) {
  const guarantees = file.guarantees ?? [];
  check(guarantees.length === 1 && guarantees[0].tests?.length === 1, 'existing-case-definition-omitted');
  const guarantee = guarantees[0],
    spec = guarantee.tests[0];
  check(
    ID.test(guarantee.id) &&
      typeof guarantee.reason === 'string' &&
      guarantee.reason.length >= 20 &&
      guarantee.context?.authorResponsibility === true &&
      typeof guarantee.context.reviewedBy === 'string' &&
      guarantee.context.reviewedBy.trim() &&
      typeof guarantee.context.summary === 'string' &&
      guarantee.context.summary.length >= 20 &&
      Array.isArray(guarantee.proofs) &&
      guarantee.proofs.length,
    'invalid-guarantee',
  );
  check(
    spec.caseSelection && spec.baselineId === 'mirage/test/power-fx-language.test.mjs:236:2',
    'invalid-existing-case-guard',
  );
  return { guarantee, spec };
}

function verifyMigratedGuidCase(file, oldModel, currentModel, guarantee, item, facts, values) {
  const correction = (file.moduleReview?.fixtureCorrections ?? []).filter(
    (entry) => entry.binding === 'CASES' && entry.index === 138,
  );
  const arrays = (model) =>
    model.ast.body.flatMap((statement) =>
      statement.type === 'VariableDeclaration'
        ? statement.declarations.filter((entry) => entry.id?.name === 'CASES' && entry.init?.type === 'ArrayExpression')
        : [],
    );
  const baseline = arrays(oldModel),
    current = arrays(currentModel);
  const [error, caught] = item.factIds.map((id) => facts.get(id));
  check(
    correction.length === 1 &&
      correction[0].sameGuarantee === true &&
      correction[0].guaranteeId === guarantee.id &&
      typeof correction[0].reviewedBy === 'string' &&
      correction[0].reviewedBy.trim() &&
      typeof correction[0].reason === 'string' &&
      correction[0].reason.length >= 20 &&
      jsonHash(correction[0].factIds) === jsonHash(item.factIds) &&
      item.factIds.length === 2 &&
      baseline.length === 1 &&
      current.length === 1 &&
      baseline[0].init.elements[138]?.type === 'ArrayExpression' &&
      baseline[0].init.elements[138].elements[0]?.value === values[0] &&
      baseline[0].init.elements[138].elements[1]?.value === true &&
      parityAstHash(baseline[0].init.elements[138]) === correction[0].oldAstSha256 &&
      parityAstHash(current[0].init.elements[138]) === correction[0].currentAstSha256 &&
      jsonHash(values[1]) === jsonHash({ errorKind: 25 }) &&
      error?.proof.mode === 'official-package' &&
      caught?.proof.mode === 'official-package' &&
      error.value?.expression === values[0] &&
      error.value.phase === 'evaluation' &&
      error.value.kind === 'error' &&
      error.value.type === 'ErrorValue' &&
      error.value.errorKind === 25 &&
      error.value.errorKindName === 'InvalidArgument' &&
      caught.value?.expression === `IfError(${values[0]},FirstError.Kind=25)` &&
      caught.value.phase === 'evaluation' &&
      caught.value.kind === 'value' &&
      caught.value.type === 'BooleanValue' &&
      caught.value.value === true,
    'case-migration-guid-bridge-required',
  );
}

function verifyMigratedSelection(spec, prior) {
  const selected = spec.caseSelection.selected;
  check(
    Array.isArray(selected) &&
      selected.length > prior[0].caseSelection.selected.length &&
      selected.every(
        (item, index) =>
          Number.isInteger(item.caseIndex) &&
          item.caseIndex >= 0 &&
          item.caseIndex < spec.caseUniverse.count &&
          (!index || selected[index - 1].caseIndex < item.caseIndex) &&
          Array.isArray(item.factIds) &&
          item.factIds.length,
      ),
    'invalid-case-parity-selection',
  );
  const oldSelected = prior[0].caseSelection.selected;
  check(
    oldSelected.every((item) => selected.some((candidate) => jsonHash(candidate) === jsonHash(item))),
    'existing-case-fact-mapping-omitted',
  );
  const priorIndices = new Set(oldSelected.map((item) => item.caseIndex));
  const added = selected.filter((item) => !priorIndices.has(item.caseIndex));
  check(added.length > 0, 'invalid-case-parity-selection');
  return { selected, added };
}

function verifyMigratedAddedCases(file, oldModel, currentModel, guarantee, prior, added, facts) {
  for (const item of added) {
    const input = prior[0].caseSelection.bindings[item.caseIndex],
      values = Object.values(input ?? {});
    if (item.caseIndex === 138) {
      verifyMigratedGuidCase(file, oldModel, currentModel, guarantee, item, facts, values);
      continue;
    }
    check(
      values.length === 2 &&
        typeof values[0] === 'string' &&
        item.factIds.every((id) => {
          const fact = facts.get(id);
          return (
            fact?.proof.mode === 'official-package' &&
            fact.value?.expression === values[0] &&
            fact.value.kind === 'value' &&
            jsonHash(fact.value.value) === jsonHash(values[1])
          );
        }),
      'case-migration-fact-mismatch',
    );
  }
}

function appendMigratedGuidEdits(body, markers, marker, before, selected, descriptor, edits) {
  const markerIndex = body.indexOf(markers[0]),
    branch = body[markerIndex - 1];
  check(
    markerIndex === body.length - 2 &&
      branch?.type === 'IfStatement' &&
      branch.consequent?.type === 'BlockStatement' &&
      branch.consequent.body.at(-1)?.type === 'ReturnStatement',
    'case-migration-guid-branch-changed',
  );
  const args = marker.arguments.map((argument) => before.slice(...argument.range));
  args[2] = JSON.stringify(selected.map((item) => item.caseIndex));
  args[4] = JSON.stringify([descriptor]);
  edits.push(
    { start: branch.range[0], end: branch.range[0], text: `${CASE_IMPORT}(${args.join(',')});\n` },
    { start: markers[0].range[0], end: markers[0].range[1], text: '' },
  );
}

function collectMigratedCoexistence(node, prior, descriptor, coexistenceEdits) {
  if (!node || typeof node !== 'object') return;
  if (
    node.type === 'Property' &&
    !node.computed &&
    (node.key?.name ?? node.key?.value) === 'coexistingCaseGuardSha256'
  ) {
    check(node.value?.type === 'Literal' && node.value.value === jsonHash(prior[0]), 'changed-coexisting-case-guard');
    coexistenceEdits.push({
      start: node.value.range[0],
      end: node.value.range[1],
      text: JSON.stringify(jsonHash(descriptor)),
    });
  }
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value])
      if (child?.type) collectMigratedCoexistence(child, prior, descriptor, coexistenceEdits);
}

function extendMigratedCase(root, file, before, oldModel, currentModel, proofContext) {
  const { guarantee, spec } = validateMigratedGuarantee(file);
  const sourceGuards = currentModel.ast.body.filter(
    (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === IMPORT,
  );
  check(sourceGuards.length === 1, 'invalid-existing-case-guard');
  const prior = guardDescriptors(sourceGuards[0].expression);
  check(
    prior.length === 1 && prior[0].caseBodyMigration && prior[0].baselineId === spec.baselineId,
    'invalid-existing-case-guard',
  );
  validateParityBindings(pathToFileURL(path.resolve(root, file.path)), prior);
  const old = oldModel.registrations.find((row) => row.id === spec.baselineId),
    row = registration(currentModel, spec);
  check(
    old &&
      oldModel.sourceSha256 === prior[0].caseBodyMigration.sourceHashes[0] &&
      jsonHash(spec.caseUniverse) === jsonHash(prior[0].caseUniverse) &&
      spec.regions?.length === 1 &&
      spec.regions[0].assertions?.length === 1 &&
      old.assertions.some((item) => item.sha256 === spec.regions[0].assertions[0].sha256),
    'existing-case-binding-changed',
  );
  const body = row.callback.body.body,
    markers = body.filter(
      (statement) => statement.type === 'ExpressionStatement' && statement.expression?.callee?.name === CASE_IMPORT,
    );
  check(markers.length === 1 && row.loops.length === 1, 'invalid-existing-case-guard');

  check(
    parityAstHash(stripMigratedCaseMarker(row.loops[0])) === prior[0].caseBodyMigration.candidateLoopSha256,
    'changed-case-migration-loop',
  );
  const { selected, added } = verifyMigratedSelection(spec, prior);
  const facts = new Map();
  for (const proof of guarantee.proofs) {
    prove(root, proof, proofContext);
    const capsule = JSON.parse(fs.readFileSync(confined(root, proof.path), 'utf8'));
    for (const fact of proof.facts) {
      check(!facts.has(fact.id), 'ambiguous-fact-id');
      facts.set(fact.id, { proof, value: pointer(capsule, fact.pointer) });
    }
  }
  const proofs = guarantee.proofs.map((proof) => publicProof(proof, proofContext));
  check(
    prior[0].proofs.length && prior[0].proofs.every((proof, index) => jsonHash(proof) === jsonHash(proofs[index])),
    'existing-case-proof-omitted',
  );
  verifyMigratedAddedCases(file, oldModel, currentModel, guarantee, prior, added, facts);
  const guidAdded = added.some((item) => item.caseIndex === 138);
  const descriptor = {
    ...prior[0],
    proofs,
    caseSelection: { ...prior[0].caseSelection, selected, ...(guidAdded ? { guardBeforeGuidBranch: true } : {}) },
  };
  const marker = markers[0].expression;
  // Existing whole-test guards can pin the case descriptor as a coexisting
  // guard. Validate them first, then rebind only that exact digest.
  assertParityBindingsFromSource(pathToFileURL(path.resolve(root, file.path)));
  const coexistenceEdits = [];

  for (const registration of currentModel.registrations) {
    const first = registration.callback.body?.body?.[0];
    if (first?.type === 'ExpressionStatement' && first.expression?.callee?.name === IMPORT)
      collectMigratedCoexistence(first.expression, prior, descriptor, coexistenceEdits);
  }
  const edits = [
    {
      start: sourceGuards[0].expression.arguments[1].range[0],
      end: sourceGuards[0].expression.arguments[1].range[1],
      text: JSON.stringify([descriptor]),
    },
    ...(!guidAdded
      ? [
          {
            start: marker.arguments[2].range[0],
            end: marker.arguments[2].range[1],
            text: JSON.stringify(selected.map((item) => item.caseIndex)),
          },
          {
            start: marker.arguments[4].range[0],
            end: marker.arguments[4].range[1],
            text: JSON.stringify([descriptor]),
          },
        ]
      : []),
    ...coexistenceEdits,
  ];
  if (guidAdded) appendMigratedGuidEdits(body, markers, marker, before, selected, descriptor, edits);
  let after = before;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  return { after, descriptor, count: selected.length, added: added.length };
}

function prepareRecordsExistingPartial(root, file, oldModel, partial, proofContext, before, currentModel) {
  const diskModel = describeParitySource(fs.readFileSync(path.resolve(root, file.path), 'utf8'), file.path);
  const existingPartial = unwrapExistingPartial(root, file, diskModel.source, diskModel, oldModel);
  if (existingPartial) {
    const unwrapped = describeParitySource(existingPartial.source, file.path);
    const removals = [];
    for (const descriptor of existingPartial.descriptors) {
      const guarantee = partial.find((entry) => entry.tests[0].baselineId === descriptor.baselineId);
      check(guarantee && descriptor.recordsFixture, 'existing-partial-binding-changed');
      const spec = guarantee.tests[0],
        row = registration(unwrapped, spec);
      const markers = row.callback.body.body.filter(
        (statement) =>
          statement.type === 'ExpressionStatement' && statement.expression?.callee?.name === RECORDS_IMPORT,
      );
      check(
        markers.length === 1 &&
          parityAstHash({ ...markers[0], expression: canonicalRecordsMarker(markers[0].expression) }) ===
            descriptor.recordsFixture.markerAstSha256,
        'invalid-records-fixture-marker',
      );
      const proofs = guarantee.proofs.map((proof) => publicProof(proof, proofContext));
      check(
        descriptor.proofs.every((proof, index) => jsonHash(proof) === jsonHash(proofs[index])),
        'existing-partial-proof-changed',
      );
      for (const [index, region] of descriptor.regionHashes.entries()) {
        const priorPairs = region.map((hash, offset) => [hash, descriptor.regionFactIds[index][offset]]);
        const matches = spec.regions.flatMap((candidate) => {
          const pairs = candidate.assertions.map((assertion) => [assertion.sha256, assertion.factIds]);
          return pairs.flatMap((_, start) =>
            jsonHash(pairs.slice(start, start + priorPairs.length)) === jsonHash(priorPairs) ? [start] : [],
          );
        });
        check(matches.length === 1, 'existing-partial-region-changed');
      }
      removals.push(markers[0]);
    }
    let clean = existingPartial.source;
    for (const statement of removals.toSorted((a, b) => b.range[0] - a.range[0]))
      clean = clean.slice(0, statement.range[0]) + clean.slice(statement.range[1]);
    before = clean;
    currentModel = describeParitySource(clean, file.path);
    modelSourcePaths.set(currentModel, path.resolve(root, file.path));
  }
  return { before, currentModel, existingPartial };
}
function prepareRecordsMixed(
  root,
  file,
  before,
  oldModel,
  currentModel,
  proofContext,
  { reviewFile, reviewedSourceFile },
) {
  const reviewSha = verifyRecordsReview(root, file, oldModel, currentModel, reviewFile, reviewedSourceFile);
  const guarantees = file.guarantees ?? [];
  const whole = guarantees.filter((item) => item.tests.length === 1 && item.tests[0].assertions);
  const partial = guarantees.filter((item) => item.tests.length === 1 && item.tests[0].regions);
  const ids = partial.map((item) => item.tests[0].baselineId).sort(compareCodeUnits);
  check(
    whole.length === 6 &&
      partial.length === 3 &&
      guarantees.length === 9 &&
      jsonHash(ids) ===
        jsonHash([
          'mirage/test/dataverse-records.test.mjs:2106:0',
          'mirage/test/dataverse-records.test.mjs:2128:0',
          'mirage/test/dataverse-records.test.mjs:875:0',
        ]),
    'records-cumulative-guards-required',
  );
  const originalGuards = new Set(
    oldModel.registrations.flatMap((row) => row.assertions.filter(isHashGuard).map((item) => item.sha256)),
  );
  const implementationSources = (file.importRoles ?? [])
    .filter((role) => role.role === 'implementation-under-test')
    .map((role) => role.source);
  const prior = whole.map((guarantee) => {
    const spec = guarantee.tests[0],
      old = oldModel.registrations.find((row) => row.id === spec.baselineId),
      row = registration(currentModel, spec);
    check(old && row.kinds.includes('parity') && !spec.regions, 'records-append-binding-required');
    const call = row.callback.body.body[0]?.expression,
      descriptor = guardDescriptors(call)[0];
    check(
      descriptor?.baselineId === spec.baselineId &&
        descriptor.recordsReviewSha256 === reviewSha &&
        descriptor.recordsFixture &&
        descriptor.guardedBodyAstSha256,
      'records-append-binding-required',
    );
    check(
      jsonHash(old.assertions.map((item) => item.sha256)) === jsonHash(descriptor.originalAssertions) &&
        jsonHash(spec.assertions.map((item) => item.sha256)) === jsonHash(descriptor.originalAssertions),
      'changed-original-assertion',
    );
    const facts = new Set(guarantee.proofs.flatMap((proof) => prove(root, proof, proofContext)));
    check(
      spec.assertions.every((item) => item.factIds?.length && item.factIds.every((id) => facts.has(id))),
      'assertion-fact-binding-required',
    );
    const proofs = guarantee.proofs.map((proof) => publicProof(proof, proofContext));
    check(
      descriptor.proofs.length &&
        descriptor.proofs.every((proof, index) => jsonHash(proof) === jsonHash(proofs[index])),
      'stale-generated-guard',
    );
    verifyUniverse(old, row, spec, oldModel, currentModel);
    return { guarantee, spec, old, row, descriptor, proofs };
  });
  check(new Set(prior.map((item) => item.spec.baselineId)).size === 6, 'records-cumulative-guards-required');
  check(
    prior.every(
      (item) =>
        jsonHash(item.descriptor.importRoles) === jsonHash(prior[0].descriptor.importRoles) &&
        jsonHash(item.descriptor.inputDependencies) === jsonHash(prior[0].descriptor.inputDependencies) &&
        jsonHash(item.descriptor.runtimeInputs) === jsonHash(prior[0].descriptor.runtimeInputs),
    ) && jsonHash(file.importRoles) === jsonHash(prior[0].descriptor.importRoles),
    'records-cumulative-input-bindings-changed',
  );
  let existingPartial;
  ({ before, currentModel, existingPartial } = prepareRecordsExistingPartial(
    root,
    file,
    oldModel,
    partial,
    proofContext,
    before,
    currentModel,
  ));
  const selected = partial.map((guarantee) => {
    const spec = guarantee.tests[0],
      old = oldModel.registrations.find((row) => row.id === spec.baselineId),
      current = registration(currentModel, spec);
    const analysis = analyzeRecordsFixtureSlice({
      baselineAst: oldModel.ast,
      currentAst: currentModel.ast,
      selected: [{ old, current }],
      implementationSources,
    });
    const facts = new Set(guarantee.proofs.flatMap((proof) => prove(root, proof, proofContext)));
    const verified = verifyPartial(
      oldModel,
      currentModel,
      spec,
      facts,
      { replacements: new Map(), fixtureBindings: new Map() },
      analysis,
    );
    return { ...verified, guarantee, analysis };
  });
  const edits = selected.map((item) => {
    const names = item.analysis.guardInsertion.inputBindings;
    check(names.length && names.every((name) => /^[A-Za-z_$][\w$]*$/u.test(name)), 'invalid-records-fixture-marker');
    return {
      position: item.analysis.guardInsertion.currentStatement.range[0],
      text: `${RECORDS_IMPORT}({${names.join(',')}}, ${JSON.stringify(item.analysis.descriptor)});\n`,
    };
  });
  let intermediate = before;
  for (const edit of edits.toSorted((a, b) => b.position - a.position))
    intermediate = intermediate.slice(0, edit.position) + edit.text + intermediate.slice(edit.position);
  const model = describeParitySource(intermediate, file.path);
  const moduleHash = moduleContextHash(model, { originalGuards }),
    isolationHash = isolationRegistrationHash(model, originalGuards);
  const descriptors = selected.map((item) => {
    const row = registration(model, item.spec),
      marker = row.callback.body.body.find(
        (statement) =>
          statement.type === 'ExpressionStatement' && statement.expression?.callee?.name === RECORDS_IMPORT,
      );
    check(marker, 'invalid-records-fixture-marker');
    return {
      baselineId: item.spec.baselineId,
      repositoryRoot: path.relative(path.dirname(path.resolve(root, file.path)), root).replaceAll(path.sep, '/') || '.',
      titleExpressionSha256: item.spec.titleExpressionSha256,
      originalAssertions: item.old.assertions.map((assertion) => assertion.sha256),
      originalBodyAstSha256: parityAstHash(strippedBody(item.current, originalGuards)),
      guardedBodyAstSha256: parityAstHash(strippedBody(row, originalGuards)),
      recordsFixture: {
        fixture: item.analysis.descriptor,
        markerAstSha256: parityAstHash(marker),
        setupAstSha256: parityAstHash(item.analysis.guardInsertion.currentStatement),
        inputBindings: item.analysis.guardInsertion.inputBindings,
      },
      recordsReviewSha256: reviewSha,
      originalGuardHashes: [...originalGuards].sort(compareCodeUnits),
      moduleContextAstSha256: moduleHash,
      isolationRegistrationsAstSha256: isolationHash,
      importRoles: prior[0].descriptor.importRoles,
      runtimeInputs: prior[0].descriptor.runtimeInputs,
      inputDependencies: prior[0].descriptor.inputDependencies,
      sourceBindings: item.spec.caseUniverse.sourceBindings,
      loopHeaders: item.old.loopHeaders,
      caseUniverse: item.spec.caseUniverse,
      proofs: item.guarantee.proofs.map((proof) => publicProof(proof, proofContext)),
      regionHashes: item.spec.regions.map((region) => region.assertions.map((assertion) => assertion.sha256)),
      regionFactIds: item.spec.regions.map((region) => region.assertions.map((assertion) => assertion.factIds)),
    };
  });
  for (const priorDescriptor of existingPartial?.descriptors ?? []) {
    const next = descriptors.find((item) => item.baselineId === priorDescriptor.baselineId);
    const mutable = new Set([
      'proofs',
      'regionHashes',
      'regionFactIds',
      'moduleContextAstSha256',
      'isolationRegistrationsAstSha256',
    ]);
    check(
      next &&
        Object.keys(priorDescriptor).every(
          (key) => mutable.has(key) || jsonHash(priorDescriptor[key]) === jsonHash(next[key]),
        ),
      'existing-partial-binding-changed',
    );
  }
  for (const item of selected) {
    item.current = registration(model, item.spec);
    item.regions = item.spec.regions.map((region) => ({ region, statements: regionStatements(item.current, region) }));
  }
  let after = generatePartial(root, file, intermediate, model, selected, descriptors);
  const generatedModel = describeParitySource(after, file.path);
  const rebinding = prior.map((item) => {
    const row = registration(generatedModel, item.spec),
      call = row.callback.body.body[0].expression;
    const descriptor = {
      ...item.descriptor,
      proofs: item.proofs,
      moduleContextAstSha256: moduleHash,
      isolationRegistrationsAstSha256: isolationHash,
    };
    return { start: call.arguments[1].range[0], end: call.arguments[1].range[1], text: JSON.stringify([descriptor]) };
  });
  for (const edit of rebinding.sort((a, b) => b.start - a.start))
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  return { after, descriptors };
}

function descriptorPart0(
  { root, file, caseMigration, conciseSpecs, correctedAssertions },
  { spec, old },
  _selectedIndex,
) {
  return {
    baselineId: spec.baselineId,
    repositoryRoot: path.relative(path.dirname(path.resolve(root, file.path)), root).replaceAll(path.sep, '/') || '.',
    titleExpressionSha256: spec.titleExpressionSha256,
    ...(spec.parentTitleExpressionSha256 ? { parentTitleExpressionSha256: spec.parentTitleExpressionSha256 } : {}),
    ...(old.callback.expression && !caseMigration ? { originalCallbackExpression: true } : {}),
    ...(conciseSpecs.length ? { conciseSpecs } : {}),
    originalAssertions: old.assertions.map((item) => correctedAssertions.get(item.node) ?? item.sha256),
    ...(old.assertions.some((item) => correctedAssertions.has(item.node))
      ? { baselineOriginalAssertions: old.assertions.map((item) => item.sha256) }
      : {}),
  };
}
function descriptorPart1(
  {
    caseMigration,
    conciseSpecs,
    recordsOriginalBodies,
    currentModel,
    originalGuards,
    generated,
    workModel,
    oldModel,
    retainedSpecs,
  },
  { spec, old },
  selectedIndex,
) {
  return {
    originalBodyAstSha256:
      recordsOriginalBodies.get(spec.baselineId) ??
      parityAstHash(
        strippedBody(
          registration(currentModel, spec),
          originalGuards,
          new Map(),
          old.callback.expression && !caseMigration,
          new Set(spec.retainedUniverseAssertions ?? []),
        ),
      ),
    ...(generated.recordsSlice
      ? {
          guardedBodyAstSha256: parityAstHash(
            strippedBody(registration(workModel, spec), originalGuards, new Map(), false),
          ),
        }
      : {}),
    ...(generated.recordsSlice
      ? {
          recordsFixture: {
            fixture: generated.records[selectedIndex].descriptor,
            markerAstSha256: parityAstHash(
              registration(workModel, spec).callback.body.body.find(
                (statement) =>
                  statement.type === 'ExpressionStatement' && statement.expression?.callee?.name === RECORDS_IMPORT,
              ),
            ),
            setupAstSha256: parityAstHash(generated.records[selectedIndex].guardInsertion.currentStatement),
            inputBindings: generated.records[selectedIndex].guardInsertion.inputBindings,
          },
        }
      : {}),
    ...(parityAstHash(strippedBody(old, originalGuards, new Map(), old.callback.expression)) !==
    parityAstHash(
      strippedBody(
        registration(currentModel, spec),
        originalGuards,
        new Map(),
        old.callback.expression && !caseMigration,
        new Set(spec.retainedUniverseAssertions ?? []),
      ),
    )
      ? {
          baselineBodyAstSha256: parityAstHash(strippedBody(old, originalGuards, new Map(), old.callback.expression)),
        }
      : {}),
    originalGuardHashes: [...originalGuards].sort(compareCodeUnits),
    ...(spec.retainedUniverseAssertions?.length ? { retainedUniverseAssertions: spec.retainedUniverseAssertions } : {}),
    moduleContextAstSha256: moduleContextHash(workModel, {
      originalGuards,
      conciseSpecs,
      retained: retainedUniverseNodes(workModel, oldModel, retainedSpecs),
    }),
  };
}
function descriptorPart2(
  { generated, isolationRegistrationsAstSha256, existingCase, recordsReview, moduleReview, moduleDelta, imports },
  { old },
  _selectedIndex,
) {
  return {
    ...(isolationRegistrationsAstSha256 ? { isolationRegistrationsAstSha256 } : {}),
    ...(generated.hostSlice ? { coexistingCaseGuardSha256: jsonHash(existingCase.descriptors[0]) } : {}),
    ...(recordsReview ? { recordsReviewSha256: recordsReview } : {}),
    ...(moduleReview ? { moduleReview } : {}),
    ...(moduleDelta?.securityApprovals.length ? { securityApprovals: moduleDelta.securityApprovals } : {}),
    ...(moduleDelta?.securityApprovals.some((approval) => approval.baselineId === old.id)
      ? { protectedSecurity: true }
      : {}),
    importRoles: imports.roles,
    runtimeInputs: imports.runtimeInputs,
    ...(imports.lateImports.length ? { lateImports: imports.lateImports } : {}),
    ...(imports.generatedFixtures.length ? { generatedFixtures: imports.generatedFixtures } : {}),
  };
}
function descriptorPart3(
  { file, caseMigration, currentModel, generated, moduleDelta, imports },
  { spec, old },
  _selectedIndex,
) {
  return {
    ...(generated.contextCertificates?.some((certificate) => certificate.baselineId === spec.baselineId)
      ? {
          memoryContextCertificates: generated.contextCertificates
            .filter((certificate) => certificate.baselineId === spec.baselineId)
            .map(contextCertificateBinding),
        }
      : {}),
    inputDependencies: imports.dependencies,
    ...(generated.memorySlice && file.additionalInputDependencies?.length
      ? {
          additionalInputDependencies: file.additionalInputDependencies.map(
            ({ path, sha256, readAstSha256, reviewedBy, reason }) => ({
              path,
              sha256,
              readAstSha256,
              reviewedBy,
              reason,
            }),
          ),
        }
      : {}),
    sourceBindings: spec.caseUniverse.sourceBindings.map((binding) =>
      moduleDelta?.fixtureBindings.has(binding.name)
        ? { ...binding, initializerAstSha256: moduleDelta.fixtureBindings.get(binding.name).currentHash }
        : binding,
    ),
    ...(moduleDelta?.fixtureBindings.size ? { baselineSourceBindings: spec.caseUniverse.sourceBindings } : {}),
    loopHeaders: caseMigration ? registration(currentModel, spec).loopHeaders : old.loopHeaders,
    ...(caseMigration ? { baselineLoopHeaders: old.loopHeaders } : {}),
    caseUniverse: spec.caseUniverse,
    ...(spec.caseFacts ? { caseFacts: spec.caseFacts } : {}),
    ...(spec.assertionLoops ? { assertionLoops: spec.assertionLoops } : {}),
  };
}
function descriptorPart4(
  { caseMigration, correctedAssertions, currentModel, proofContext },
  { spec, old, guarantee },
  _selectedIndex,
) {
  return {
    ...(spec.caseSelection
      ? {
          caseSelection: {
            selected: spec.caseSelection.selected,
            bindings: spec.caseUniverse.currentCaseBindings ?? spec.caseUniverse.caseBindings,
            source: old.loops[0].right.name,
            names: Object.keys(spec.caseUniverse.caseBindings[0]),
            parentKinds: registration(currentModel, spec).kinds,
            ...(caseMigration ? { retainedAssertionHashes: caseMigration.verified.retainedAssertionHashes } : {}),
          },
        }
      : {}),
    proofs: guarantee.proofs.map((proof) => publicProof(proof, proofContext)),
    ...(guarantee.supplementalWitness ? { supplementalWitness: guarantee.supplementalWitness } : {}),
    ...(caseMigration
      ? {
          caseBodyMigration: {
            sourceHashes: caseMigration.verified.sourceHashes,
            candidateLoopSha256: caseMigration.verified.candidateLoopSha256,
            candidateLoopHeaderSha256: caseMigration.verified.candidateLoopHeaderSha256,
            historicalIndices: caseMigration.verified.historicalIndices,
          },
        }
      : {}),
    ...(spec.regions && !spec.caseSelection
      ? {
          regionHashes: spec.regions.map((region) =>
            region.assertions.map((item) => {
              const original = old.assertions.find((assertion) => assertion.sha256 === item.sha256);
              return original && correctedAssertions.has(original.node)
                ? correctedAssertions.get(original.node)
                : item.sha256;
            }),
          ),
          regionFactIds: spec.regions.map((region) => region.assertions.map((item) => item.factIds)),
        }
      : {}),
  };
}
function dispatchExactQualification({ root, file, original, before, oldModel, currentModel, proofContext, report }) {
  if (file.path === 'mirage/test/dataverse-query-reader.test.mjs') {
    const cumulative = currentModel.identifiers.has(QUERY_IMPORT);
    const result = cumulative
      ? extendQueryMatrix(root, file, before, oldModel, currentModel, proofContext)
      : qualifyQueryMatrix(root, file, before, oldModel, currentModel, proofContext);
    const count = cumulative ? result.count : 5,
      added = cumulative ? result.added : 5;
    report.qualifiedOriginalCases += count;
    report.newQualifiedOriginalCases += added;
    report.files.push({
      path: file.path,
      originalDefinitions: 0,
      newOriginalDefinitions: 0,
      expandedOriginalCases: 0,
      newExpandedOriginalCases: 0,
      qualifiedOriginalCases: count,
      newQualifiedOriginalCases: added,
      beforeSha256: parityHash(before),
      afterSha256: parityHash(result.after),
      proofBindingTestsAdded: 0,
    });
    if (result.after !== before)
      report.changes.push({ path: file.path, before, after: result.after, bindings: [result.binding] });
    return true;
  }
  if (file.path === 'mirage/test/dataverse-soap-xml.test.mjs') {
    const result = qualifySoapLoop(root, file, original, before, oldModel, currentModel, proofContext);
    report.files.push({
      path: file.path,
      originalDefinitions: 0,
      newOriginalDefinitions: 0,
      expandedOriginalCases: 0,
      newExpandedOriginalCases: 0,
      qualifiedOriginalCases: 0,
      newQualifiedOriginalCases: 0,
      partialAssertions: 44,
      beforeSha256: parityHash(before),
      afterSha256: parityHash(result.after),
      proofBindingTestsAdded: 0,
    });
    report.changes.push({ path: file.path, before, after: result.after, bindings: [result.binding] });
    return true;
  }
  if (file.path === 'mirage/test/dataverse-scalar-reader-http.test.mjs') {
    const result = qualifyScalarMigration(root, file, original, before, proofContext);
    report.files.push({
      path: file.path,
      originalDefinitions: 0,
      newOriginalDefinitions: 0,
      expandedOriginalCases: 0,
      newExpandedOriginalCases: 0,
      partialRegions: 2,
      qualifiedOriginalCases: 0,
      newQualifiedOriginalCases: 0,
      partialAssertions: 272,
      beforeSha256: parityHash(before),
      afterSha256: parityHash(result.after),
      proofBindingTestsAdded: 0,
    });
    report.changes.push({ path: file.path, before, after: result.after, bindings: [result.descriptor] });
    return true;
  }
  return false;
}
function dispatchMigratedPowerFx({ root, file, before, oldModel, currentModel, proofContext, report }) {
  if (
    file.path === 'mirage/test/power-fx-language.test.mjs' &&
    currentModel.identifiers.has(CASE_IMPORT) &&
    (file.guarantees ?? []).some((guarantee) => guarantee.tests.some((spec) => spec.caseSelection))
  ) {
    const result = extendMigratedCase(root, file, before, oldModel, currentModel, proofContext);
    report.qualifiedOriginalCases += result.count;
    report.newQualifiedOriginalCases += result.added;
    report.files.push({
      path: file.path,
      originalDefinitions: 0,
      newOriginalDefinitions: 0,
      expandedOriginalCases: 0,
      newExpandedOriginalCases: 0,
      partialRegions: 1,
      qualifiedOriginalCases: result.count,
      newQualifiedOriginalCases: result.added,
      beforeSha256: parityHash(before),
      afterSha256: parityHash(result.after),
      proofBindingTestsAdded: 0,
    });
    if (result.after !== before)
      report.changes.push({ path: file.path, before, after: result.after, bindings: [result.descriptor] });
    return true;
  }
  return false;
}
function inspectQualificationRoutes(file, oldModel, currentModel) {
  let apiRouter, routing;
  const selectedSpecs = (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests ?? []);
  if (selectedSpecs.length === 1 && selectedSpecs[0].baselineId === 'mirage/test/dataverse-api.test.mjs:615:2') {
    apiRouter = reviewApiRouterSlice({
      baselineAst: oldModel.ast,
      currentAst: currentModel.ast,
      baselineId: selectedSpecs[0].baselineId,
    });
  }
  if (
    !apiRouter &&
    oldModel.ast.body.some((node) => node.type === 'ImportDeclaration' && node.source.value === 'node:http') &&
    oldModel.ast.body.some(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.source.value === 'node:test' &&
        node.specifiers.some((part) => part.imported?.name === 'before'),
    )
  ) {
    routing = analyzeEachRoutingInput(file, oldModel, currentModel);
  }
  if (!apiRouter) {
    verifyTestRegistrations(oldModel, routing?.old);
    verifyTestRegistrations(currentModel, routing?.current);
  }
  verifyAssertionBindings(oldModel);
  verifyAssertionBindings(currentModel);
  return { apiRouter, routing };
}
function prepareExistingQualification({ root, file, candidate, currentModel, oldModel, caseMigration, routing }) {
  let partialBefore, existingCase;
  const requestedIds = new Set(
    (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests.map((spec) => spec.baselineId)),
  );
  partialBefore = caseMigration
    ? null
    : (unwrapExistingPartial(root, file, candidate, currentModel, oldModel) ??
      unwrapExistingCase(root, file, candidate, currentModel, requestedIds));
  if (partialBefore?.preserveOnly) {
    existingCase = partialBefore;
    partialBefore = null;
  }
  if (
    partialBefore &&
    !partialBefore.caseGuard &&
    partialBefore.descriptors.every((descriptor) => !requestedIds.has(descriptor.baselineId)) &&
    (file.guarantees ?? []).every((guarantee) => guarantee.tests.every((spec) => !spec.regions && !spec.caseSelection))
  ) {
    // The verified partial guard protects other registrations; retain it and
    // its regions untouched while adding a whole-test binding elsewhere.
    partialBefore = null;
  }
  if (partialBefore) {
    currentModel = describeParitySource(partialBefore.source, file.path);
    modelSourcePaths.set(currentModel, path.resolve(root, file.path));
    if (routing) {
      routing = analyzeEachRoutingInput(file, oldModel, currentModel);
    }
  }
  verifyProtectedKinds(oldModel, currentModel);
  const fallback = explicitFallback(file, oldModel, currentModel);
  check(
    !currentModel.tags.errors.length ||
      (fallback && currentModel.tags.errors.every((error) => error.includes('test has no @test-kind'))),
    'existing-test-kind-errors',
  );
  return { partialBefore, existingCase, currentModel, routing };
}
function appendReviewedRecordsGuard({
  guarantee,
  oldModel,
  currentModel,
  reviewSha,
  root,
  proofContext,
  edits,
  descriptors,
}) {
  const spec = guarantee.tests[0],
    old = oldModel.registrations.find((item) => item.id === spec.baselineId),
    row = registration(currentModel, spec);
  check(old && row.kinds.includes('parity') && !spec.regions && !spec.caseSelection, 'records-append-binding-required');
  const call = row.callback.body.body[0]?.expression,
    prior = guardDescriptors(call);
  check(
    prior.length === 1 &&
      prior[0].baselineId === spec.baselineId &&
      prior[0].recordsReviewSha256 === reviewSha &&
      prior[0].recordsFixture &&
      prior[0].guardedBodyAstSha256,
    'records-append-binding-required',
  );
  const hashes = old.assertions.map((item) => item.sha256);
  check(
    jsonHash(hashes) === jsonHash(prior[0].originalAssertions) &&
      jsonHash(spec.assertions.map((item) => item.sha256)) === jsonHash(hashes) &&
      hashes.every((hash) => row.assertions.some((item) => item.sha256 === hash)),
    'changed-original-assertion',
  );
  const factIds = new Set(guarantee.proofs.flatMap((proof) => prove(root, proof, proofContext)));
  check(
    spec.assertions.every(
      (item) => Array.isArray(item.factIds) && item.factIds.length && item.factIds.every((id) => factIds.has(id)),
    ),
    'assertion-fact-binding-required',
  );
  verifyUniverse(old, row, spec, oldModel, currentModel);
  const proofs = guarantee.proofs.map((proof) => publicProof(proof, proofContext));
  check(
    prior[0].proofs.length > 0 && prior[0].proofs.every((proof, index) => jsonHash(proof) === jsonHash(proofs[index])),
    'stale-generated-guard',
  );
  const descriptor = { ...prior[0], proofs };
  if (jsonHash(descriptor) !== jsonHash(prior[0]))
    edits.push({
      start: call.arguments[1].range[0],
      end: call.arguments[1].range[1],
      text: JSON.stringify([descriptor]),
    });
  descriptors.push(descriptor);
}
function dispatchMixedRecords({
  root,
  file,
  before,
  oldModel,
  currentModel,
  proofContext,
  recordsReviewFile,
  recordsReviewedSourceFile,
  report,
  appendSpecs,
}) {
  if (
    file.path === 'mirage/test/dataverse-records.test.mjs' &&
    appendSpecs.length === 9 &&
    currentModel.identifiers.has(RECORDS_IMPORT)
  ) {
    try {
      const mixed = prepareRecordsMixed(root, file, before, oldModel, currentModel, proofContext, {
        reviewFile: recordsReviewFile,
        reviewedSourceFile: recordsReviewedSourceFile,
      });
      report.originalDefinitions += 6;
      report.expandedOriginalCases += 6;
      report.alreadyParityDefinitions += 6;
      report.files.push({
        path: file.path,
        originalDefinitions: 6,
        newOriginalDefinitions: 0,
        expandedOriginalCases: 6,
        newExpandedOriginalCases: 0,
        partialRegions: appendSpecs.reduce((count, spec) => count + (spec.regions?.length ?? 0), 0),
        qualifiedOriginalCases: 0,
        newQualifiedOriginalCases: 0,
        beforeSha256: parityHash(before),
        afterSha256: parityHash(mixed.after),
        proofBindingTestsAdded: 0,
      });
      if (mixed.after !== before)
        report.changes.push({ path: file.path, before, after: mixed.after, bindings: mixed.descriptors });
    } catch (error) {
      report.pending.push(pending(file, null, error));
    }
    return true;
  }
  return false;
}
function dispatchRecordsQualification({
  root,
  file,
  before,
  oldModel,
  currentModel,
  proofContext,
  recordsReviewFile,
  recordsReviewedSourceFile,
  report,
}) {
  const appendSpecs = (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests ?? []);
  if (
    dispatchMixedRecords({
      root,
      file,
      before,
      oldModel,
      currentModel,
      proofContext,
      recordsReviewFile,
      recordsReviewedSourceFile,
      report,
      appendSpecs,
    })
  )
    return true;
  if (
    file.path === 'mirage/test/dataverse-records.test.mjs' &&
    appendSpecs.length === 6 &&
    appendSpecs.some((spec) => spec.baselineId === 'mirage/test/dataverse-records.test.mjs:2351:0') &&
    currentModel.identifiers.has(RECORDS_IMPORT)
  ) {
    try {
      const reviewSha = verifyRecordsReview(
        root,
        file,
        oldModel,
        currentModel,
        recordsReviewFile,
        recordsReviewedSourceFile,
      );
      check(
        file.guarantees.length === 6 &&
          file.guarantees.every((guarantee) => guarantee.tests.length === 1) &&
          new Set(appendSpecs.map((spec) => spec.baselineId)).size === 6,
        'records-append-binding-required',
      );
      const edits = [],
        descriptors = [];
      for (const guarantee of file.guarantees)
        appendReviewedRecordsGuard({
          guarantee,
          oldModel,
          currentModel,
          reviewSha,
          root,
          proofContext,
          edits,
          descriptors,
        });
      let after = before;
      for (const edit of edits.toSorted((a, b) => b.start - a.start))
        after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
      report.originalDefinitions += 6;
      report.expandedOriginalCases += 6;
      report.alreadyParityDefinitions += 6;
      report.files.push({
        path: file.path,
        originalDefinitions: 6,
        newOriginalDefinitions: 0,
        expandedOriginalCases: 6,
        newExpandedOriginalCases: 0,
        partialRegions: 0,
        qualifiedOriginalCases: 0,
        newQualifiedOriginalCases: 0,
        beforeSha256: parityHash(before),
        afterSha256: parityHash(after),
        proofBindingTestsAdded: 0,
      });
      if (after !== before) report.changes.push({ path: file.path, before, after, bindings: descriptors });
    } catch (error) {
      report.pending.push(pending(file, null, error));
    }
    return true;
  }
  return false;
}
function analyzeSdkQualification(state) {
  const { file, oldModel, currentModel, recordsSpecs, report, recordsReview } = state;
  let { generated } = state;
  if (file.path === 'mirage/test/code-apps-sdk.test.mjs' && recordsSpecs.length === 1) {
    try {
      generated = {
        old: analyzeSdkLateHarness(oldModel, recordsSpecs[0]),
        current: analyzeSdkLateHarness(currentModel, recordsSpecs[0]),
        sdkHarnessSlice: true,
      };
    } catch (error) {
      report.pending.push(pending(file, null, error));
      return false;
    }
  }
  state.generated = generated;
  state.recordsReview = recordsReview;
  return true;
}
function analyzeRecordsQualification(state) {
  const { root, file, oldModel, currentModel, recordsSpecs, recordsReviewFile, recordsReviewedSourceFile, report } =
    state;
  let { generated, recordsReview } = state;
  if (
    recordsSpecs.length &&
    oldModel.ast.body.some(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.source.value === 'node:crypto' &&
        node.specifiers.some((part) => part.imported?.name === 'randomUUID'),
    )
  ) {
    try {
      for (const model of [oldModel, currentModel]) {
        rejectRecordsScheduling(model.ast);
      }
      const records = recordsSpecs.map((spec) =>
        analyzeRecordsFixtureSlice({
          baselineAst: oldModel.ast,
          currentAst: currentModel.ast,
          selected: [
            {
              old: oldModel.registrations.find((row) => row.id === spec.baselineId),
              current: registration(currentModel, spec),
            },
          ],
          implementationSources: (file.importRoles ?? [])
            .filter((role) => role.role === 'implementation-under-test')
            .map((role) => role.source),
        }),
      );
      const merge = (side, key) => new Set(records.flatMap((result) => [...result[side][key]]));
      const version = (side) => ({
        recognizedIdentifiers: merge(side, 'recognizedIdentifiers'),
        isolatedIdentifiers: merge(side, 'isolatedIdentifiers'),
        recognizedBuiltinImports: merge(side, 'recognizedBuiltinImports'),
        recognizedExternalInputs: merge(side, 'recognizedExternalInputs'),
        handledInputSources: merge(side, 'handledInputSources'),
        dependencies: [],
        fixtures: [],
      });
      generated = { old: version('old'), current: version('current'), recordsSlice: true, records };
      if (file.path === 'mirage/test/dataverse-records.test.mjs') {
        recordsReview = verifyRecordsReview(
          root,
          file,
          oldModel,
          currentModel,
          recordsReviewFile,
          recordsReviewedSourceFile,
        );
        const prior = currentModel.registrations.flatMap((row) => {
          const call = row.callback.body?.body?.[0]?.expression;
          return call?.type === 'CallExpression' && call.callee?.name === IMPORT ? guardDescriptors(call) : [];
        });
        check(
          prior.length === 6 &&
            new Set(prior.map((item) => item.baselineId)).size === 6 &&
            prior.every((item) => recordsSpecs.some((spec) => spec.baselineId === item.baselineId)),
          'records-cumulative-guards-required',
        );
      }
    } catch (error) {
      if (
        file.path === 'mirage/test/dataverse-records.test.mjs' ||
        error.qualificationCode !== 'unsupported-records-fixture-slice'
      ) {
        report.pending.push(pending(file, null, error));
        return false;
      }
    }
  }
  state.generated = generated;
  state.recordsReview = recordsReview;
  return true;
}
function analyzeRouterQualification(state) {
  const { oldModel, currentModel, apiRouter, recordsReview } = state;
  let { generated } = state;
  if (apiRouter) {
    const version = (model) => {
      const recognizedExternalInputs = new Set();
      function collect(node) {
        if (node.type === 'Identifier' && node.name === 'fetch') recognizedExternalInputs.add(node);
        if (
          node.type === 'MemberExpression' &&
          node.object?.name === 'process' &&
          !node.computed &&
          node.property.name === 'env'
        )
          recognizedExternalInputs.add(node);
        childNodes(node).forEach(collect);
      }
      // The reviewed immutable Program snapshot binds every exact ambient node;
      // runtime source and registration guards continue to pin the full file.
      collect(model.ast);
      return {
        recognizedExternalInputs,
        recognizedIdentifiers: new Set(),
        isolatedIdentifiers: new Set(),
        recognizedBuiltinImports: new Set(
          model.ast.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === 'node:http'),
        ),
        handledInputSources: new Set(),
        dependencies: [],
        fixtures: [],
      };
    };
    generated = { old: version(oldModel), current: version(currentModel), apiRouterSlice: true };
  }
  state.generated = generated;
  state.recordsReview = recordsReview;
  return true;
}
function analyzeGeneratedFixtureQualification(state) {
  const { root, file, oldModel, currentModel, report, readBaseline, recordsReview } = state;
  let { generated } = state;
  if (oldModel.ast.body.some((node) => node.type === 'ImportDeclaration' && node.source.value === 'node:os')) {
    try {
      const specs = (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests ?? []);
      const oldSelected = specs.map((spec) => ({
        old: oldModel.registrations.find((row) => row.id === spec.baselineId),
        assertionHashes: (spec.regions ?? []).flatMap((region) =>
          region.assertions.map((assertion) => assertion.sha256),
        ),
      }));
      check(
        oldSelected.every((item) => item.old),
        'stale-baseline-id',
      );
      const currentSelected = specs.map((spec) => ({
        old: registration(currentModel, spec),
        assertionHashes: (spec.regions ?? []).flatMap((region) =>
          region.assertions.map((assertion) => assertion.sha256),
        ),
      }));
      const implementationSources = (file.importRoles ?? [])
        .filter((role) => role.role === 'implementation-under-test')
        .map((role) => role.source);
      generated = {
        old: analyzeGeneratedFixtures({
          ast: oldModel.ast,
          selected: oldSelected,
          root,
          filePath: file.path,
          readBaseline,
          implementationSources,
        }),
        current: analyzeGeneratedFixtures({
          ast: currentModel.ast,
          selected: currentSelected,
          root,
          filePath: file.path,
          readBaseline,
          implementationSources,
        }),
      };
      if (!generated.old.fixtures.length && !generated.current.fixtures.length) {
        generated = {
          old: analyzeEachUnselectedFixture({
            ast: oldModel.ast,
            selected: oldSelected,
            root,
            filePath: file.path,
            readBaseline,
            implementationSources,
          }),
          current: analyzeFixtureSliceWithExistingGuards(
            root,
            file,
            currentModel,
            currentSelected,
            readBaseline,
            implementationSources,
            { baselineModel: oldModel, analyzer: analyzeEachUnselectedFixture },
          ),
        };
        generated.fixtureSlice =
          generated.old.isolatedIdentifiers.size > 0 && generated.current.isolatedIdentifiers.size > 0;
      }
      const normalized = (items) => items.map(({ baselineId: _id, ...item }) => item);
      check(
        jsonHash(normalized(generated.old.fixtures)) === jsonHash(normalized(generated.current.fixtures)),
        'generated-fixture-source-changed',
      );
      for (const version of [generated.old, generated.current])
        for (const node of version.isolatedIdentifiers) version.recognizedIdentifiers.add(node);
    } catch (error) {
      report.pending.push(pending(file, null, error));
      return false;
    }
  }
  state.generated = generated;
  state.recordsReview = recordsReview;
  return true;
}
function analyzeMemoryAnchors({
  old,
  partialBefore,
  specs,
  oldSelected,
  root,
  file,
  implementationSources,
  oldModel,
  currentModel,
  readBaseline,
  proofContext,
  generated,
}) {
  if (!old.requiresAllRegistrations && partialBefore && !partialBefore.caseGuard) {
    const protectedIds = new Set(partialBefore.descriptors.map((item) => item.baselineId));
    const anchorSpecs = specs.filter(
      (spec, i) =>
        protectedIds.has(spec.baselineId) &&
        analyzeMemoryRendererSlice({
          ast: oldModel.ast,
          selected: [oldSelected[i]],
          root,
          filePath: file.path,
          implementationSources,
        }).requiresAllRegistrations,
    );
    const anchorIds = new Set(anchorSpecs.map((spec) => spec.baselineId));
    if (anchorSpecs.length) {
      check(
        specs.every(
          (spec) =>
            !protectedIds.has(spec.baselineId) ||
            anchorIds.has(spec.baselineId) ||
            partialBefore.descriptors.some(
              (item) => item.baselineId === spec.baselineId && item.memoryContextCertificates?.length,
            ),
        ),
        'memory-context-protected-anchor-required',
      );
      const oldAnchors = anchorSpecs.map((spec) => ({
        old: oldModel.registrations.find((row) => row.id === spec.baselineId),
      }));
      const currentAnchors = anchorSpecs.map((spec) => ({ old: registration(currentModel, spec) }));
      const oldAnchor = analyzeMemoryRendererSlice({
        ast: oldModel.ast,
        selected: oldAnchors,
        root,
        filePath: file.path,
        implementationSources,
      });
      const currentAnchor = analyzeFixtureSliceWithExistingGuards(
        root,
        file,
        currentModel,
        currentAnchors,
        readBaseline,
        implementationSources,
        { baselineModel: oldModel, analyzer: analyzeMemoryRendererSlice },
      );
      const normalized = (items) => items.map(({ baselineId: _id, ...item }) => item);
      check(
        oldAnchor.requiresAllRegistrations &&
          currentAnchor.requiresAllRegistrations &&
          jsonHash(normalized(oldAnchor.fixtures)) === jsonHash(normalized(currentAnchor.fixtures)),
        'memory-context-anchor-drift',
      );
      const previewGuards = new Set(
        oldModel.registrations.flatMap((row) => row.assertions.filter(isHashGuard).map((item) => item.sha256)),
      );
      const previewConcise = oldModel.registrations
        .filter((row) => row.callback.type === 'ArrowFunctionExpression' && row.callback.expression)
        .map((row) => ({
          titleExpressionSha256: row.titleExpressionSha256,
          ...(row.parent ? { parentTitleExpressionSha256: row.parent.titleExpressionSha256 } : {}),
        }));
      const preview = file.moduleReview?.corrections?.length
        ? reviewedModuleDeltas(root, file, oldModel, currentModel, previewGuards, proofContext, {
            conciseSpecs: previewConcise,
            fixtureSlice: true,
            memorySlice: true,
          })
        : null;
      const certificates = specs
        .filter((spec) => !anchorIds.has(spec.baselineId))
        .flatMap((spec) => {
          check(
            Array.isArray(spec.regions) && spec.regions.length && !spec.assertions && !spec.caseSelection,
            'memory-context-region-required',
          );
          return spec.regions.flatMap((region) =>
            region.assertions.map((assertion) =>
              memoryContextCertificate(currentModel, spec, assertion, preview, implementationSources),
            ),
          );
        });
      check(
        certificates.length &&
          certificates.every(
            (certificate) => certificate.moduleIsolationRequired === true && certificate.nativeParityProven === false,
          ),
        'memory-context-certificate-required',
      );
      generated = {
        old: oldAnchor,
        current: currentAnchor,
        fixtureSlice: true,
        memorySlice: true,
        contextCertificates: certificates,
      };
    }
  }
  return generated;
}
function analyzeMemoryFixtureQualification(state) {
  const { root, file, oldModel, currentModel, report, readBaseline, partialBefore, proofContext, recordsReview } =
    state;
  let { generated } = state;
  if (!generated.old) {
    try {
      const { specs, oldSelected, currentSelected, implementationSources } = selectedSliceInputs(
        file,
        oldModel,
        currentModel,
      );
      const old = analyzeMemoryRendererSlice({
        ast: oldModel.ast,
        selected: oldSelected,
        root,
        filePath: file.path,
        implementationSources,
      });
      generated = analyzeMemoryAnchors({
        old,
        partialBefore,
        specs,
        oldSelected,
        root,
        file,
        implementationSources,
        oldModel,
        currentModel,
        readBaseline,
        proofContext,
        generated,
      });
      if (old.requiresAllRegistrations && !generated.old) {
        const current = analyzeFixtureSliceWithExistingGuards(
          root,
          file,
          currentModel,
          currentSelected,
          readBaseline,
          implementationSources,
          { baselineModel: oldModel, analyzer: analyzeMemoryRendererSlice },
        );
        const normalized = (items) => items.map(({ baselineId: _id, ...item }) => item);
        check(
          current.requiresAllRegistrations &&
            jsonHash(normalized(old.fixtures)) === jsonHash(normalized(current.fixtures)),
          'generated-fixture-source-changed',
        );
        generated = { old, current, fixtureSlice: true, memorySlice: true };
      }
    } catch (error) {
      report.pending.push(pending(file, null, error));
      return false;
    }
  }
  state.generated = generated;
  state.recordsReview = recordsReview;
  return true;
}
function analyzePowerFxHostQualification(state) {
  const { root, file, oldModel, currentModel, report, readBaseline, existingCase, recordsReview } = state;
  let { generated } = state;
  if (!generated.old && existingCase) {
    try {
      const { oldSelected, currentSelected, implementationSources } = selectedSliceInputs(file, oldModel, currentModel);
      const old = analyzePowerFxHostSlice({
        ast: oldModel.ast,
        selected: oldSelected,
        root,
        filePath: file.path,
        implementationSources,
      });
      if (old.requiresAllRegistrations) {
        const current = analyzeFixtureSliceWithExistingGuards(
          root,
          file,
          currentModel,
          currentSelected,
          readBaseline,
          implementationSources,
          { baselineModel: oldModel, analyzer: analyzePowerFxHostSlice, retainModuleScaffolding: true },
        );
        const normalized = (items) => items.map(({ baselineId: _id, ...item }) => item);
        check(
          current.requiresAllRegistrations &&
            jsonHash(normalized(old.fixtures)) === jsonHash(normalized(current.fixtures)),
          'generated-fixture-source-changed',
        );
        generated = { old, current, fixtureSlice: true, hostSlice: true };
      }
    } catch (error) {
      report.pending.push(pending(file, null, error));
      return false;
    }
  }
  state.generated = generated;
  state.recordsReview = recordsReview;
  return true;
}
function resolveQualificationDelta({
  file,
  oldModel,
  currentModel,
  caseMigration,
  generated,
  existingCase,
  routing,
  apiRouter,
  recordsReview,
  conciseSpecs,
  originalGuards,
  report,
  moduleDelta,
}) {
  if (caseMigration) {
    const name = file.caseBodyMigration.review.caseBinding;
    const oldBinding = oldModel.declarations.filter((item) => item.name === name && item.ownerTitle === null);
    const currentBinding = currentModel.declarations.filter((item) => item.name === name && item.ownerTitle === null);
    check(oldBinding.length === 1 && currentBinding.length === 1, 'case-migration-binding');
    moduleDelta = {
      review: file.moduleReview,
      replacements: new Map(),
      securityApprovals: [],
      fixtureBindings: new Map([
        [
          name,
          { baselineHash: oldBinding[0].initializerAstSha256, currentHash: currentBinding[0].initializerAstSha256 },
        ],
      ]),
      verifiedCaseBody: caseMigration.verified,
    };
  }
  if (generated.hostSlice) {
    const review = file.moduleReview,
      scope = review?.hostSlice;
    if (!(
      review &&
      Array.isArray(review.addedTests) &&
      review.addedTests.length === 0 &&
      scope?.zeroNewCredit === true &&
      scope.priorCaseGuardSha256 === jsonHash(existingCase.descriptors[0]) &&
      typeof scope.reviewedBy === 'string' &&
      scope.reviewedBy.length > 0 &&
      typeof scope.reason === 'string' &&
      scope.reason.trim().length >= 20
    )) {
      report.pending.push(pending(file, null, { qualificationCode: 'reviewed-host-slice-required' }));
      return null;
    }
    moduleDelta = {
      review,
      replacements: new Map(),
      fixtureBindings: new Map(),
      securityApprovals: [],
      hostSlice: true,
    };
  }
  if (routing) {
    try {
      const n = routing.normalization;
      const replacements = new Map([
        [n.currentBefore, n.oldBefore],
        [n.currentAfter, n.oldAfter],
      ]);
      const ignored = new Set([n.addedDeclaration]);
      check(
        moduleContextHash(oldModel, { originalGuards, conciseSpecs }) ===
          moduleContextHash(currentModel, { replacements, ignored, originalGuards, conciseSpecs }),
        'changed-routing-module-context',
      );
      moduleDelta = {
        replacements: new Map(),
        fixtureBindings: new Map(),
        securityApprovals: [],
        routingSlice: true,
      };
    } catch (error) {
      report.pending.push(pending(file, null, error));
      return null;
    }
  }
  if (apiRouter)
    moduleDelta = {
      replacements: new Map(),
      fixtureBindings: new Map(),
      securityApprovals: [],
      apiRouterSlice: true,
    };
  if (recordsReview)
    moduleDelta = {
      replacements: new Map(),
      fixtureBindings: new Map(),
      securityApprovals: [],
      recordsReviewSha256: recordsReview,
    };
  return { moduleDelta };
}
function prepareQualificationContext({
  root,
  file,
  oldModel,
  currentModel,
  caseMigration,
  generated,
  existingCase,
  routing,
  apiRouter,
  recordsReview,
  proofContext,
  conciseSpecs,
  originalGuards,
  report,
  moduleDelta,
}) {
  const resolved = resolveQualificationDelta({
    root,
    file,
    oldModel,
    currentModel,
    caseMigration,
    generated,
    existingCase,
    routing,
    apiRouter,
    recordsReview,
    proofContext,
    conciseSpecs,
    originalGuards,
    report,
    moduleDelta,
  });
  if (!resolved) return null;
  moduleDelta = resolved.moduleDelta;
  const retainedSpecs = (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests ?? []);
  let retainedCurrent;
  try {
    retainedCurrent = retainedUniverseNodes(currentModel, oldModel, retainedSpecs);
  } catch (error) {
    report.pending.push(pending(file, null, error));
    return null;
  }
  let isolationRegistrationsAstSha256, baselineIsolationRegistrationsAstSha256;
  if (
    caseMigration ||
    routing ||
    apiRouter ||
    generated.recordsSlice ||
    generated.sdkHarnessSlice ||
    generated.hostSlice ||
    generated.memorySlice ||
    generated.old?.isolatedIdentifiers.size ||
    generated.current?.isolatedIdentifiers.size
  ) {
    try {
      isolationRegistrationsAstSha256 = isolationRegistrationHash(currentModel, originalGuards, conciseSpecs);
      if (!caseMigration && !generated.hostSlice && !routing && !apiRouter && !recordsReview)
        baselineIsolationRegistrationsAstSha256 = isolationRegistrationHash(oldModel, originalGuards, conciseSpecs);
    } catch (error) {
      report.pending.push(pending(file, null, error));
      return null;
    }
  }
  if (
    !caseMigration &&
    !routing &&
    !apiRouter &&
    !recordsReview &&
    !generated.hostSlice &&
    file.moduleReview &&
    moduleContextHash(oldModel, { originalGuards, conciseSpecs }) !==
      moduleContextHash(currentModel, { originalGuards, conciseSpecs, retained: retainedCurrent })
  ) {
    try {
      moduleDelta = reviewedModuleDeltas(root, file, oldModel, currentModel, originalGuards, proofContext, {
        conciseSpecs,
        fixtureSlice: generated.fixtureSlice,
        memorySlice: generated.memorySlice,
      });
    } catch (error) {
      report.pending.push(pending(file, null, error));
      return null;
    }
  }
  if (
    baselineIsolationRegistrationsAstSha256 &&
    baselineIsolationRegistrationsAstSha256 !== isolationRegistrationsAstSha256 &&
    !moduleDelta
  ) {
    report.pending.push(pending(file, null, { qualificationCode: 'changed-isolation-registrations' }));
    return null;
  }
  return { moduleDelta, retainedSpecs, retainedCurrent, isolationRegistrationsAstSha256 };
}
function collectQualificationGuarantees({
  root,
  file,
  oldModel,
  currentModel,
  proofContext,
  moduleDelta,
  generated,
  baselineIds,
  selected,
  guarantees,
  report,
}) {
  for (const guarantee of file.guarantees ?? []) {
    try {
      check(
        ID.test(guarantee.id) &&
          typeof guarantee.reason === 'string' &&
          guarantee.reason.length >= 20 &&
          !/[\r\n]/u.test(guarantee.reason),
        'invalid-guarantee',
      );
      check(
        guarantee.context?.authorResponsibility === true &&
          typeof guarantee.context.reviewedBy === 'string' &&
          guarantee.context.reviewedBy.length &&
          typeof guarantee.context.summary === 'string' &&
          guarantee.context.summary.length >= 20,
        'reviewed-semantic-context-required',
      );
      check(
        Array.isArray(guarantee.proofs) &&
          guarantee.proofs.length &&
          Array.isArray(guarantee.tests) &&
          guarantee.tests.length,
        'proof-and-original-tests-required',
      );
      const facts = guarantee.proofs.flatMap((proof) =>
        prove(root, proof, { ...proofContext, supplementalWitness: guarantee.supplementalWitness }),
      );
      check(new Set(facts).size === facts.length, 'ambiguous-fact-id');
      const matched = guarantee.tests.map((spec) =>
        spec.regions
          ? verifyPartial(oldModel, currentModel, spec, new Set(facts), moduleDelta, generated)
          : verifyTest(oldModel, currentModel, spec, new Set(facts), generated, moduleDelta),
      );
      for (const match of matched) {
        check(!baselineIds.has(match.old.id), 'duplicate-original-definition');
        baselineIds.add(match.old.id);
        selected.push({ ...match, guarantee });
      }
      guarantees.push(guarantee);
    } catch (error) {
      report.pending.push(pending(file, guarantee, error));
    }
  }
}
function reviewQualificationSource({
  root,
  file,
  oldModel,
  currentModel,
  readBaseline,
  selected,
  generated,
  caseMigration,
  originalGuards,
  conciseSpecs,
  retainedCurrent,
  moduleDelta,
  proofContext,
  report,
}) {
  let imports;
  try {
    imports = reviewedImports(root, file, oldModel, readBaseline, selected, {
      generated: generated.old,
      currentModel,
      fixtureSlice: generated.fixtureSlice,
      memorySlice: generated.memorySlice,
    });
    if (caseMigration) {
      const dependencies = new Map(imports.dependencies.map((item) => [item.path, item.sha256]));
      for (const item of caseMigration.dependencies) {
        check(
          !dependencies.has(item.path) || dependencies.get(item.path) === item.sha256,
          'changed-test-input-dependency',
        );
        dependencies.set(item.path, item.sha256);
      }
      imports.dependencies = [...dependencies]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, sha256]) => ({ path, sha256 }));
    }
  } catch (error) {
    report.pending.push(pending(file, null, error));
    return null;
  }
  if (
    !moduleDelta &&
    moduleContextHash(oldModel, { originalGuards, conciseSpecs }) !==
      moduleContextHash(currentModel, { originalGuards, conciseSpecs, retained: retainedCurrent })
  ) {
    try {
      moduleDelta = reviewedModuleDeltas(root, file, oldModel, currentModel, originalGuards, proofContext, {
        conciseSpecs,
        fixtureSlice: generated.fixtureSlice,
        memorySlice: generated.memorySlice,
      });
    } catch (error) {
      report.pending.push(pending(file, null, error));
      return null;
    }
  }
  const moduleReview = moduleDelta?.review;
  if (selected.some((item) => item.partial) && selected.some((item) => !item.partial)) {
    report.pending.push(pending(file, null, { qualificationCode: 'mixed-whole-and-partial-file' }));
    return null;
  }
  // A file is one transaction: do not partly write it after another guarantee failed.
  if (report.pending.some((item) => item.file === file.path)) return null;
  if (file.fallbackKind !== undefined) {
    const selectedIds = new Set(selected.map((item) => item.old.id));
    const unselected = oldModel.registrations
      .filter((item) => !selectedIds.has(item.id))
      .map((item) => item.id)
      .sort(compareCodeUnits);
    if (
      jsonHash([...new Set(file.fallbackUnselectedBaselineIds)].sort(compareCodeUnits)) !== jsonHash(unselected) ||
      file.fallbackUnselectedBaselineIds.length !== unselected.length
    ) {
      report.pending.push(pending(file, null, { qualificationCode: 'unselected-baseline-ids-do-not-match' }));
      return null;
    }
  }
  return { imports, moduleDelta, moduleReview };
}
function countSelectedOriginals(selected, report) {
  for (const item of selected) {
    if (!item.partial) {
      report.originalDefinitions++;
      report.expandedOriginalCases += item.spec.caseUniverse.count;
      if (item.current.kinds.includes('parity')) report.alreadyParityDefinitions++;
    }
  }
}
function prepareQualificationWorkSource({
  root,
  file,
  caseMigration,
  partialBefore,
  candidate,
  currentModel,
  moduleDelta,
  isolationRegistrationsAstSha256,
  originalGuards,
  conciseSpecs,
  generated,
  selected,
}) {
  let workSource = caseMigration?.candidateSource ?? partialBefore?.source ?? candidate;
  let workModel = currentModel;
  const recordsOriginalBodies = new Map();
  if (moduleDelta?.enumBindings?.length) {
    check(
      moduleDelta.enumBindings.length === 1 &&
        moduleDelta.enumBindings[0].name === 'ErrorKind' &&
        moduleDelta.enumBindings[0].member === 'Numeric' &&
        moduleDelta.enumBindings[0].value === 24,
      'invalid-enum-binding',
    );
    const expected = parse(
      "if (ErrorKind.Numeric !== 24) throw new Error('official ErrorKind.Numeric binding changed');",
      { ecmaVersion: 'latest', sourceType: 'module' },
    ).body[0];
    if (!workModel.ast.body.some((node) => parityAstHash(node) === parityAstHash(expected)))
      workSource += "\nif (ErrorKind.Numeric !== 24) throw new Error('official ErrorKind.Numeric binding changed');\n";
    workModel = describeParitySource(workSource, file.path);
    modelSourcePaths.set(workModel, path.resolve(root, file.path));
    if (isolationRegistrationsAstSha256)
      isolationRegistrationsAstSha256 = isolationRegistrationHash(workModel, originalGuards, conciseSpecs);
  }
  if (generated.recordsSlice) {
    check(
      !currentModel.identifiers.has(RECORDS_IMPORT) && selected.every((item) => !item.partial),
      'invalid-records-fixture-marker',
    );
    const edits = generated.records.map((result, index) => {
      const item = selected[index],
        row = registration(currentModel, item.spec);
      recordsOriginalBodies.set(
        item.spec.baselineId,
        parityAstHash(strippedBody(row, originalGuards, new Map(), false)),
      );
      const names = result.guardInsertion.inputBindings;
      check(names.length && names.every((name) => /^[A-Za-z_$][\w$]*$/u.test(name)), 'invalid-records-fixture-marker');
      return {
        position: result.guardInsertion.currentStatement.range[0],
        text: `${RECORDS_IMPORT}({${names.join(',')}}, ${JSON.stringify(result.descriptor)});\n`,
      };
    });
    const imports = currentModel.ast.body.filter((node) => node.type === 'ImportDeclaration');
    check(imports.length > 0, 'invalid-records-fixture-marker');
    const helper = path.resolve(path.dirname(TOOL), 'parity-records-fixture-slice.mjs');
    let relative = path.relative(path.dirname(path.resolve(root, file.path)), helper).replaceAll(path.sep, '/');
    if (path.isAbsolute(relative)) relative = pathToFileURL(helper).href;
    else if (!relative.startsWith('.')) relative = './' + relative;
    edits.push({
      position: imports.at(-1).range[1],
      text: `\nimport { assertRecordsFixtureLiterals as ${RECORDS_IMPORT} } from ${JSON.stringify(relative)};`,
    });
    for (const edit of edits.toSorted((a, b) => b.position - a.position))
      workSource = workSource.slice(0, edit.position) + edit.text + workSource.slice(edit.position);
    workModel = describeParitySource(workSource, file.path);
    modelSourcePaths.set(workModel, path.resolve(root, file.path));
    for (const item of selected) item.current = registration(workModel, item.spec);
    isolationRegistrationsAstSha256 = isolationRegistrationHash(workModel, originalGuards, conciseSpecs);
  }
  return { workSource, workModel, recordsOriginalBodies, isolationRegistrationsAstSha256 };
}
function renderQualificationCandidate({
  partialBefore,
  selected,
  descriptors,
  reviewedCandidateFile,
  moduleDelta,
  root,
  file,
  workSource,
  workModel,
  before,
  report,
  guarantees,
}) {
  let after;
  try {
    if (partialBefore) {
      check(
        selected.every((item) => item.partial),
        'existing-partial-requires-cumulative-manifest',
      );
      if (partialBefore.caseGuard) preserveExistingCase(partialBefore.descriptors, descriptors);
      else
        preserveExistingPartial(
          partialBefore.descriptors,
          descriptors,
          reviewedCandidateFile ? moduleDelta?.replacements : null,
        );
    }
    after = selected[0].partial
      ? generatePartial(root, file, workSource, workModel, selected, descriptors)
      : generate(root, file, workSource, workModel, selected, descriptors);
    if (partialBefore) {
      if (jsonHash(partialBefore.descriptors) === jsonHash(descriptors)) after = before;
      else
        after =
          '// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.\n' +
          after;
    }
  } catch (error) {
    report.pending.push(pending(file, guarantees[0], error));
    report.originalDefinitions -= selected.filter((item) => !item.partial).length;
    report.expandedOriginalCases -= selected
      .filter((item) => !item.partial)
      .reduce((n, item) => n + item.spec.caseUniverse.count, 0);
    report.alreadyParityDefinitions -= selected.filter(
      (item) => !item.partial && item.current.kinds.includes('parity'),
    ).length;
    return null;
  }
  return after;
}
function checkReceiptPathCollision(manifest, root, destination) {
  check(
    !manifest.files.some((entry) => path.resolve(root, entry.path) === destination) &&
      !manifest.files.some((entry) =>
        (entry.guarantees ?? []).some((guarantee) =>
          guarantee.proofs.some((item) => path.resolve(root, item.path) === destination),
        ),
      ),
    'cdn-receipt-path-collision',
  );
}
function prepareOneQualificationReceipt(proof, { proofContext, root, manifest, report }) {
  const prepared = proofContext.prepared.get(proof);
  if (!prepared) return;
  const receipt = prepared.receipt,
    destination = receiptDestination(root, receipt.path);
  checkReceiptPathCollision(manifest, root, destination);
  const prior = report.receiptChanges.find((item) => item.path === receipt.path);
  if (prior) {
    check(prior.after === receipt.after, 'cdn-receipt-conflict');
    return;
  }
  const beforeReceipt = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : null;
  check(beforeReceipt === null || beforeReceipt === receipt.after, 'cdn-receipt-conflict');
  if (beforeReceipt === null) report.receiptChanges.push({ path: receipt.path, before: null, after: receipt.after });
}
function prepareQualificationReceipts({ selected, proofContext, root, manifest, report, file }) {
  try {
    for (const { guarantee } of selected)
      for (const proof of guarantee.proofs)
        prepareOneQualificationReceipt(proof, { proofContext, root, manifest, report });
  } catch (error) {
    report.pending.push(pending(file, null, error));
    report.originalDefinitions -= selected.filter((item) => !item.partial).length;
    report.expandedOriginalCases -= selected
      .filter((item) => !item.partial)
      .reduce((n, item) => n + item.spec.caseUniverse.count, 0);
    report.alreadyParityDefinitions -= selected.filter(
      (item) => !item.partial && item.current.kinds.includes('parity'),
    ).length;
    return false;
  }
  return true;
}
function buildQualificationCandidate({
  root,
  file,
  oldModel,
  currentModel,
  selected,
  moduleDelta,
  caseMigration,
  partialBefore,
  candidate,
  originalGuards,
  conciseSpecs,
  generated,
  retainedSpecs,
  isolationRegistrationsAstSha256,
  recordsReview,
  moduleReview,
  imports,
  proofContext,
  report,
  guarantees,
  manifest,
  before,
  existingCase,
  reviewedCandidateFile,
}) {
  countSelectedOriginals(selected, report);
  const correctedAssertions = new Map(
    [...(moduleDelta?.replacements ?? new Map())].map(([current, old]) => [old, parityAstHash(current)]),
  );
  const {
    workSource,
    workModel,
    recordsOriginalBodies,
    isolationRegistrationsAstSha256: workIsolationSha,
  } = prepareQualificationWorkSource({
    root,
    file,
    caseMigration,
    partialBefore,
    candidate,
    currentModel,
    moduleDelta,
    isolationRegistrationsAstSha256,
    originalGuards,
    conciseSpecs,
    generated,
    selected,
  });
  isolationRegistrationsAstSha256 = workIsolationSha;
  const descriptorContext = {
    root,
    file,
    caseMigration,
    conciseSpecs,
    correctedAssertions,
    recordsOriginalBodies,
    currentModel,
    originalGuards,
    generated,
    workModel,
    oldModel,
    retainedSpecs,
    isolationRegistrationsAstSha256,
    existingCase,
    recordsReview,
    moduleReview,
    moduleDelta,
    imports,
    proofContext,
  };
  const descriptors = selected.map((item, index) => ({
    ...descriptorPart0(descriptorContext, item, index),
    ...descriptorPart1(descriptorContext, item, index),
    ...descriptorPart2(descriptorContext, item, index),
    ...descriptorPart3(descriptorContext, item, index),
    ...descriptorPart4(descriptorContext, item, index),
  }));
  const after = renderQualificationCandidate({
    partialBefore,
    selected,
    descriptors,
    reviewedCandidateFile,
    moduleDelta,
    root,
    file,
    workSource,
    workModel,
    before,
    report,
    guarantees,
  });
  if (after === null) return null;
  if (!prepareQualificationReceipts({ selected, proofContext, root, manifest, report, file })) return null;
  return { after, descriptors };
}
function prepareQualificationFile({
  manifest,
  root,
  file,
  readBaseline,
  reviewedCandidateFile,
  caseCandidateFile,
  proofContext,
  report,
}) {
  let oldModel, currentModel, before, candidate, partialBefore, existingCase, caseMigration, routing, apiRouter;
  try {
    check(SHA.test(file.baselineSha256) && SHA.test(file.currentSha256), 'file-source-pins-required');
    before = fs.readFileSync(confined(root, file.path), 'utf8');
    const original = readBaseline(file.path);
    candidate = reviewedCandidateFile ? fs.readFileSync(reviewedCandidateFile, 'utf8') : before;
    check(
      !reviewedCandidateFile || (manifest.files.length === 1 && file.moduleReview && !file.caseBodyMigration),
      'reviewed-candidate-not-supported',
    );
    check(parityHash(original) === file.baselineSha256, 'stale-baseline-sha');
    check(parityHash(candidate) === file.currentSha256, 'stale-current-sha');
    oldModel = describeParitySource(original, file.path);
    caseMigration = prepareCaseBodyMigration(root, file, original, before, caseCandidateFile, proofContext);
    currentModel = describeParitySource(caseMigration?.candidateSource ?? candidate, file.path);
    modelSourcePaths.set(currentModel, path.resolve(root, file.path));
    if (dispatchExactQualification({ root, file, original, before, oldModel, currentModel, proofContext, report }))
      return null;
    ({ apiRouter, routing } = inspectQualificationRoutes(file, oldModel, currentModel));
    if (dispatchMigratedPowerFx({ root, file, before, oldModel, currentModel, proofContext, report })) return null;
    ({ partialBefore, existingCase, currentModel, routing } = prepareExistingQualification({
      root,
      file,
      candidate,
      currentModel,
      oldModel,
      caseMigration,
      routing,
    }));
  } catch (error) {
    report.pending.push(pending(file, null, error));
    return null;
  }
  return { oldModel, currentModel, before, candidate, partialBefore, existingCase, caseMigration, routing, apiRouter };
}
function recordQualificationResult({
  report,
  moduleReview,
  caseMigration,
  oldModel,
  currentModel,
  selected,
  partialBefore,
  file,
  before,
  after,
  descriptors,
}) {
  report.newDefinitionsExcluded += moduleReview?.addedTests.length ?? 0;
  if (caseMigration) {
    const baselineTitles = new Set(oldModel.registrations.map((row) => row.titleExpressionSha256));
    report.newDefinitionsExcluded += currentModel.registrations.filter(
      (row) =>
        !baselineTitles.has(row.titleExpressionSha256) &&
        !(typeof row.title === 'string' && /^parity source bindings [a-f0-9]{16}$/u.test(row.title)),
    ).length;
  }
  const newWhole = selected.filter((item) => !item.partial && !item.current.kinds.includes('parity'));
  report.newOriginalDefinitions += newWhole.length;
  report.newExpandedOriginalCases += newWhole.reduce((count, item) => count + item.spec.caseUniverse.count, 0);
  const qualifiedOriginalCases = selected.reduce(
    (count, item) => count + (item.spec.caseSelection?.selected.length ?? 0),
    0,
  );
  report.qualifiedOriginalCases += qualifiedOriginalCases;
  let previouslyQualifiedCases = 0;
  if (caseMigration)
    previouslyQualifiedCases = selected[0].spec.caseSelection.selected.filter((item) =>
      caseMigration.verified.historicalIndices.includes(item.caseIndex),
    ).length;
  else if (partialBefore?.caseGuard)
    previouslyQualifiedCases = partialBefore.descriptors[0].caseSelection.selected.length;
  report.newQualifiedOriginalCases += qualifiedOriginalCases - previouslyQualifiedCases;
  report.files.push({
    path: file.path,
    originalDefinitions: selected.filter((item) => !item.partial).length,
    newOriginalDefinitions: newWhole.length,
    expandedOriginalCases: selected
      .filter((item) => !item.partial)
      .reduce((n, item) => n + item.spec.caseUniverse.count, 0),
    newExpandedOriginalCases: newWhole.reduce((count, item) => count + item.spec.caseUniverse.count, 0),
    partialRegions: selected.reduce((n, item) => n + (item.regions?.length ?? 0), 0),
    qualifiedOriginalCases,
    newQualifiedOriginalCases: qualifiedOriginalCases - previouslyQualifiedCases,
    beforeSha256: parityHash(before),
    afterSha256: parityHash(after),
    proofBindingTestsAdded:
      after === before || selected[0].partial || currentModel.identifiers.has(SOURCE_IMPORT) ? 0 : 1,
  });
  if (after !== before) {
    report.changes.push({ path: file.path, before, after, bindings: descriptors });
    if (!selected[0].partial && !currentModel.identifiers.has(SOURCE_IMPORT)) report.newDefinitionsExcluded++;
  }
}
function qualifyOneFile(
  file,
  {
    manifest,
    root,
    readBaseline,
    reviewedCandidateFile,
    caseCandidateFile,
    proofContext,
    report,
    recordsReviewFile,
    recordsReviewedSourceFile,
    baselineIds,
  },
) {
  const selected = [],
    guarantees = [];
  const preparedFile = prepareQualificationFile({
    manifest,
    root,
    file,
    readBaseline,
    reviewedCandidateFile,
    caseCandidateFile,
    proofContext,
    report,
  });
  if (!preparedFile) return;
  const { oldModel, currentModel, before, candidate, partialBefore, existingCase, caseMigration, routing, apiRouter } =
    preparedFile;
  let moduleDelta, recordsReview;
  if (
    dispatchRecordsQualification({
      root,
      file,
      before,
      oldModel,
      currentModel,
      proofContext,
      recordsReviewFile,
      recordsReviewedSourceFile,
      report,
    })
  )
    return;
  let generated = routing ? { ...routing, routingSlice: true } : {};
  const recordsSpecs = (file.guarantees ?? []).flatMap((guarantee) => guarantee.tests ?? []);
  const sliceState = {
    root,
    file,
    oldModel,
    currentModel,
    generated,
    recordsSpecs,
    recordsReview,
    recordsReviewFile,
    recordsReviewedSourceFile,
    report,
    apiRouter,
    readBaseline,
    partialBefore,
    proofContext,
    existingCase,
  };
  if (
    ![
      analyzeSdkQualification,
      analyzeRecordsQualification,
      analyzeRouterQualification,
      analyzeGeneratedFixtureQualification,
      analyzeMemoryFixtureQualification,
      analyzePowerFxHostQualification,
    ].every((analyze) => analyze(sliceState))
  )
    return;
  ({ generated, recordsReview } = sliceState);
  const conciseSpecs = oldModel.registrations
    .filter(
      (row) =>
        row.callback.type === 'ArrowFunctionExpression' &&
        row.callback.expression &&
        (!existingCase?.descriptors[0].caseBodyMigration || row.id !== existingCase.descriptors[0].baselineId) &&
        (!caseMigration ||
          !(file.guarantees ?? []).some((guarantee) => guarantee.tests.some((spec) => spec.baselineId === row.id))),
    )
    .map((row) => ({
      titleExpressionSha256: row.titleExpressionSha256,
      ...(row.parent ? { parentTitleExpressionSha256: row.parent.titleExpressionSha256 } : {}),
    }));
  const originalGuards = new Set(
    oldModel.registrations.flatMap((row) => row.assertions.filter(isHashGuard).map((item) => item.sha256)),
  );
  const preparedContext = prepareQualificationContext({
    root,
    file,
    oldModel,
    currentModel,
    caseMigration,
    generated,
    existingCase,
    routing,
    apiRouter,
    recordsReview,
    proofContext,
    conciseSpecs,
    originalGuards,
    report,
    moduleDelta,
  });
  if (!preparedContext) return;
  moduleDelta = preparedContext.moduleDelta;
  const { retainedSpecs, retainedCurrent } = preparedContext;
  const { isolationRegistrationsAstSha256 } = preparedContext;
  collectQualificationGuarantees({
    root,
    file,
    oldModel,
    currentModel,
    proofContext,
    moduleDelta,
    generated,
    baselineIds,
    selected,
    guarantees,
    report,
  });
  if (!selected.length) return;
  const reviewedSource = reviewQualificationSource({
    root,
    file,
    oldModel,
    currentModel,
    readBaseline,
    selected,
    generated,
    caseMigration,
    originalGuards,
    conciseSpecs,
    retainedCurrent,
    moduleDelta,
    proofContext,
    report,
  });
  if (!reviewedSource) return;
  const { imports, moduleReview } = reviewedSource;
  moduleDelta = reviewedSource.moduleDelta;
  const candidateResult = buildQualificationCandidate({
    root,
    file,
    oldModel,
    currentModel,
    selected,
    moduleDelta,
    caseMigration,
    partialBefore,
    candidate,
    originalGuards,
    conciseSpecs,
    generated,
    retainedSpecs,
    isolationRegistrationsAstSha256,
    recordsReview,
    moduleReview,
    imports,
    proofContext,
    report,
    guarantees,
    manifest,
    before,
    existingCase,
    reviewedCandidateFile,
  });
  if (!candidateResult) return;
  const { after, descriptors } = candidateResult;
  recordQualificationResult({
    report,
    moduleReview,
    caseMigration,
    oldModel,
    currentModel,
    selected,
    partialBefore,
    file,
    before,
    after,
    descriptors,
  });
}
export function qualifyParityManifest(
  manifest,
  {
    root,
    readBaseline,
    evidenceRoot,
    securityApprovalFile,
    securityApprovalSha256,
    caseCandidateFile,
    reviewedCandidateFile,
    recordsReviewFile,
    recordsReviewedSourceFile,
  } = {},
) {
  check(
    manifest?.version === 1 && /^[a-f0-9]{40}$/u.test(manifest.baseline) && Array.isArray(manifest.files),
    'invalid-manifest',
  );
  root = path.resolve(root ?? path.dirname(path.dirname(TOOL)));
  readBaseline ??= (file) =>
    execFileSync(resolveGitExecutable(), ['show', `${manifest.baseline}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  const securityBytes = securityApprovalFile ? fs.readFileSync(securityApprovalFile) : null;
  check(
    !securityBytes || (SHA.test(securityApprovalSha256) && parityHash(securityBytes) === securityApprovalSha256),
    'security-approval-digest-mismatch',
  );
  const proofContext = {
    evidenceRoot,
    prepared: new Map(),
    ...(securityBytes
      ? { securityApproval: { receipt: JSON.parse(securityBytes), sha256: parityHash(securityBytes) } }
      : {}),
  };
  const report = {
    version: 1,
    baseline: manifest.baseline,
    mode: 'dry-run',
    semanticReview:
      'Manifest author remains responsible for guarantee/context equivalence; hashes alone do not prove Microsoft behavior.',
    originalDefinitions: 0,
    newOriginalDefinitions: 0,
    qualifiedOriginalCases: 0,
    newQualifiedOriginalCases: 0,
    expandedOriginalCases: 0,
    newExpandedOriginalCases: 0,
    alreadyParityDefinitions: 0,
    newDefinitionsExcluded: 0,
    files: [],
    pending: [],
    changes: [],
    receiptChanges: [],
  };
  const baselineIds = new Set();
  for (const file of manifest.files)
    qualifyOneFile(file, {
      manifest,
      root,
      readBaseline,
      reviewedCandidateFile,
      caseCandidateFile,
      proofContext,
      report,
      recordsReviewFile,
      recordsReviewedSourceFile,
      baselineIds,
    });
  report.pending = aggregatePending(report.pending);
  return report;
}
function pending(file, guarantee, error) {
  return {
    id: 'qualifier-' + (guarantee?.id ?? parityHash(file.path).slice(0, 12)),
    area: 'parity-batch-qualification',
    createdBy: 'scripts/qualify-parity.mjs',
    status: 'pending',
    kind: 'qualification-failure',
    file: file.path,
    guarantee: guarantee?.reason ?? 'Exact baseline/current source binding',
    testIds:
      guarantee?.tests?.map((item) => item.baselineId) ??
      (file.guarantees ?? []).flatMap((item) => (item.tests ?? []).map((test) => test.baselineId)),
    reason: error.qualificationCode ?? 'qualification-input-unavailable',
    evidence: guarantee?.proofs?.map(({ path, sha256 }) => ({ path, sha256 })) ?? [],
    sharedCause: guarantee?.id ?? 'source-binding',
    nextAction:
      'Resolve the source/proof/context ambiguity, then rerun the strict dry-run; partial cases require a reviewed supported-region plan.',
    assignedTo: 'root',
  };
}
function aggregatePending(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const key = finding.sharedCause + '\0' + finding.reason;
    const group = groups.get(key) ?? {
      ...finding,
      id: 'qualifier-' + finding.sharedCause.slice(0, 70) + '-' + parityHash(finding.reason).slice(0, 8),
      files: [],
      testIds: [],
      evidence: [],
      guaranteeSummaries: [],
    };
    group.files = [...new Set([...group.files, finding.file])].sort(compareCodeUnits);
    group.testIds = [...new Set([...group.testIds, ...finding.testIds])].sort(compareCodeUnits);
    group.guaranteeSummaries = [...new Set([...group.guaranteeSummaries, finding.guarantee])].sort(compareCodeUnits);
    group.evidence = [
      ...new Map([...group.evidence, ...finding.evidence].map((item) => [JSON.stringify(item), item])).values(),
    ];
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function arrowExpressionRange(source, callback) {
  let [start, end] = callback.body.range;
  for (;;) {
    let left = start - 1,
      right = end;
    while (left >= callback.range[0] && /\s/u.test(source[left])) left--;
    while (right < callback.range[1] && /\s/u.test(source[right])) right++;
    if (source[left] !== '(' || source[right] !== ')') break;
    start = left;
    end = right + 1;
  }
  return [start, end];
}
function extractFileKindHeader(before, after, model) {
  if (!model.tags.fileKinds) return { header: '', after };
  const lines = before.split(/\r?\n/u);
  const candidates = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      ({ line, number }) =>
        /^\s*\/\/\s*@test-kind\b/u.test(line) &&
        !model.tags.regions.some((region) => !region.partial && region.start === number),
    );
  check(candidates.length === 1, 'ambiguous-file-kind-header');
  const tag = candidates[0].line;
  const at = after.indexOf(tag);
  check(at >= 0 && !after.includes(tag, at + tag.length), 'ambiguous-file-kind-header');
  const end = at + tag.length;
  let newline = 0;
  if (after.startsWith('\r\n', end)) newline = 2;
  else if (after.startsWith('\n', end)) newline = 1;
  return { header: tag + '\n', after: after.slice(0, at) + after.slice(end + newline) };
}
function generatePartial(root, file, before, model, selected, descriptors) {
  const caseMode = selected.some((item) => item.spec.caseSelection);
  check(
    !model.identifiers.has(REGION_IMPORT) &&
      !model.identifiers.has(CASE_IMPORT) &&
      (!caseMode || selected.length === 1),
    'reserved-binding-collision',
  );
  const existing = model.ast.body.find(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === IMPORT),
  );
  const resolved =
    existing &&
    (existing.source.value.startsWith('file:')
      ? fileURLToPath(existing.source.value)
      : path.resolve(root, path.dirname(file.path), existing.source.value));
  const own =
    resolved === TOOL &&
    existing.specifiers.some(
      (item) =>
        item.type === 'ImportSpecifier' && item.imported.name === 'assertParityBindings' && item.local.name === IMPORT,
    );
  check(own || !model.identifiers.has(IMPORT), 'reserved-binding-collision');
  check(file.fallbackKind === undefined, 'partial-requires-existing-test-kind');
  const edits = [];
  selected.forEach((item, index) => {
    for (const { statements } of item.regions) {
      const expressionBody = item.current.callback.body.type !== 'BlockStatement';
      const [start, end] = expressionBody
        ? arrowExpressionRange(before, item.current.callback)
        : [statements[0].range[0], statements.at(-1).range[1]];
      const selection = descriptors[index].caseSelection;
      const guard = selection
        ? `${CASE_IMPORT}(import.meta.url, ${selection.source}, ${JSON.stringify(selection.selected.map((entry) => entry.caseIndex))}, {${selection.names.join(',')}}, ${JSON.stringify([descriptors[index]])});`
        : `${REGION_IMPORT}(import.meta.url, ${JSON.stringify([descriptors[index]])});`;
      if (item.verifiedCaseBody) {
        check(
          selection && statements.length === 1 && statements[0].type === 'ReturnStatement',
          'invalid-case-parity-marker',
        );
        edits.push({ start, end: start, text: `${guard}\n` });
        continue;
      }
      edits.push({
        start,
        end,
        text: `{\n${guard}\n${expressionBody ? 'return ' : ''}${before.slice(start, end)}${expressionBody ? ';' : ''}\n}`,
      });
    }
  });
  let after = before;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  let relative = path.relative(path.dirname(path.resolve(root, file.path)), TOOL).replaceAll(path.sep, '/');
  if (path.isAbsolute(relative)) relative = pathToFileURL(TOOL).href;
  else if (!relative.startsWith('.')) relative = './' + relative;
  // A formatted descriptor can span hundreds of lines. Keep the existing file-level
  // kind at the start, before inserting the module guard, so it remains effective.
  const extracted = extractFileKindHeader(before, after, model);
  const header = extracted.header;
  after = extracted.after;
  const regionBinding = caseMode ? `parityCaseBindings as ${CASE_IMPORT}` : `parityAssertions as ${REGION_IMPORT}`;
  const sharedBinding = own ? '' : `, assertParityBindings as ${IMPORT}`;
  after =
    header +
    `import { ${regionBinding}${sharedBinding} } from ${JSON.stringify(relative)};\n${IMPORT}(import.meta.url, ${JSON.stringify(descriptors)});\n` +
    after;
  if (selected.some((item) => item.verifiedCaseBody))
    after =
      '// @parity-evidence: Exact repeated official package case results and retained historical proof assertions are bound by the generated source and evidence guards.\n' +
      after;
  const parsed = describeParitySource(after, file.path);
  check(!parsed.tags.errors.length, 'generated-test-kind-errors');
  for (let i = 0; i < selected.length; i++) {
    const row = registration(parsed, selected[i].spec);
    check(jsonHash(row.kinds) === jsonHash(selected[i].current.kinds), 'generated-parent-kind-changed');
    check(
      parityAstHash(
        strippedBody(
          row,
          new Set(descriptors[i].originalGuardHashes),
          new Map(),
          descriptors[i].originalCallbackExpression,
        ),
      ) === (descriptors[i].guardedBodyAstSha256 ?? descriptors[i].originalBodyAstSha256),
      'generated-body-changed',
    );
  }
  return after;
}
/** Synchronous proof guard used at the start of an inline assertion block. */
export function parityAssertions(moduleUrl, descriptors) {
  assertParityBindings(moduleUrl, descriptors);
}
function appendSourceGuard(source, testBinding, digest, root, file) {
  const original = describeParitySource(source, file.path);
  const binding = original.ast.body
    .filter(
      (node) => node.type === 'ImportDeclaration' && ['node:assert', 'node:assert/strict'].includes(node.source.value),
    )
    .flatMap((node) => node.specifiers)
    .find((item) => ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(item.type));
  const title = `parity source bindings ${digest}`;
  const comment =
    '// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.\n';
  const statement = binding
    ? `${binding.local.name}.doesNotThrow(() => ${SOURCE_IMPORT}(import.meta.url));`
    : `${SOURCE_IMPORT}(import.meta.url);`;
  const candidate = `${source}\n${comment}${testBinding}(${JSON.stringify(title)}, () => {\n  ${statement}\n});\n`;
  if (binding) {
    const model = describeParitySource(candidate, file.path);
    modelSourcePaths.set(model, path.resolve(root, file.path));
    const row = model.registrations.find((item) => item.title === title);
    if (!row || !isSourceGuardCallback(model, row.callback))
      return `${source}\n${comment}${testBinding}(${JSON.stringify(title)}, () => {\n  ${SOURCE_IMPORT}(import.meta.url);\n});\n`;
  }
  return candidate;
}
function wholeTestInsertions(root, before, model, selected, descriptors) {
  const insertions = selected
    .filter(
      ({ current, old }) =>
        !current.kinds.includes('parity') || (old.kinds.includes('security') && !current.kinds.includes('security')),
    )
    .map(({ current, old, guarantee }) => {
      const statement = current.statement;
      check(
        statement?.type === 'ExpressionStatement' &&
          (statement.expression === current.node ||
            (statement.expression.type === 'AwaitExpression' && statement.expression.argument === current.node)),
        'unsupported-registration-context',
      );
      const callee = model.source.slice(...current.node.callee.range);
      check(['test', 'it', 't.test'].includes(callee), 'unsupported-tag-binding');
      const indent = ' '.repeat(statement.loc.start.column);
      const security =
        old.kinds.includes('security') ||
        current.kinds.includes('security') ||
        current.parent?.kinds.includes('security');
      const comment = `// @test-kind parity${security ? '+security' : ''}: ${guarantee.reason}\n${indent}// @parity-evidence: Manifest guarantee ${guarantee.id}; exact capsule/run/fact/source bindings are asserted below.\n${indent}`;
      return { position: statement.range[0], text: comment };
    });
  // Each promoted body gets its own proof guard; the shared test additionally
  // runs outside selected branches to protect generator completeness.
  for (let index = 0; index < selected.length; index++) {
    const row = selected[index].current;
    if (row.callback.body.type !== 'BlockStatement') {
      const expressionRange = arrowExpressionRange(before, row.callback);
      insertions.push({
        position: expressionRange[0],
        end: expressionRange[1],
        text: `{\n${IMPORT}(import.meta.url, ${JSON.stringify([descriptors[index]])});\nreturn ${before.slice(...expressionRange)};\n}`,
      });
      continue;
    }
    const existing = row.callback.body.body.filter(
      (statement) =>
        statement.type === 'ExpressionStatement' &&
        statement.expression.type === 'CallExpression' &&
        statement.expression.callee.name === IMPORT,
    );
    if (existing.length) {
      check(existing.length === 1, 'stale-generated-guard');
      const prior = guardDescriptors(existing[0].expression);
      if (jsonHash(prior) !== jsonHash([descriptors[index]])) {
        check(
          prior.length === 1 && Array.isArray(prior[0].proofs) && prior[0].proofs.length > 0,
          'stale-generated-guard',
        );
        check(
          prior.length === 1 &&
            Object.entries(prior[0]).every(
              ([key, value]) =>
                Object.hasOwn(descriptors[index], key) &&
                (key === 'proofs'
                  ? Array.isArray(value) &&
                    Array.isArray(descriptors[index].proofs) &&
                    value.every((proof, position) => jsonHash(proof) === jsonHash(descriptors[index].proofs[position]))
                  : jsonHash(value) === jsonHash(descriptors[index][key])),
            ),
          'stale-generated-guard',
        );
        for (const proof of prior[0].proofs)
          prove(root, proof, { supplementalWitness: descriptors[index].supplementalWitness });
        insertions.push({
          position: existing[0].range[0],
          end: existing[0].range[1],
          text: `// @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.\n${' '.repeat(existing[0].loc.start.column)}${IMPORT}(import.meta.url, ${JSON.stringify([descriptors[index]])});`,
        });
      }
      continue;
    }
    insertions.push({
      position: row.callback.body.range[0] + 1,
      text: `\n${' '.repeat(row.node.loc.start.column + 2)}${IMPORT}(import.meta.url, ${JSON.stringify([descriptors[index]])});`,
    });
  }
  return insertions;
}
function generate(root, file, before, model, selected, descriptors) {
  const existingImport = model.ast.body.find(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === IMPORT),
  );
  let resolvedImport = null;
  if (existingImport)
    resolvedImport = existingImport.source.value.startsWith('file:')
      ? fileURLToPath(existingImport.source.value)
      : path.resolve(root, path.dirname(file.path), existingImport.source.value);
  const ownImport =
    resolvedImport === TOOL &&
    existingImport?.specifiers.some(
      (item) =>
        item.type === 'ImportSpecifier' && item.imported.name === 'assertParityBindings' && item.local.name === IMPORT,
    ) &&
    existingImport.specifiers.some(
      (item) =>
        item.type === 'ImportSpecifier' &&
        item.imported.name === 'assertParityBindingsFromSource' &&
        item.local.name === SOURCE_IMPORT,
    );
  check(
    ownImport || (!model.identifiers.has(IMPORT) && !model.identifiers.has(SOURCE_IMPORT)),
    'reserved-binding-collision',
  );
  const testBinding = ['test', 'it'].find((name) =>
    model.ast.body.some(
      (item) =>
        item.type === 'ImportDeclaration' &&
        item.source.value === 'node:test' &&
        item.specifiers.some((specifier) => specifier.local.name === name),
    ),
  );
  check(testBinding, 'supported-test-binding-required');
  let after = before;
  const insertions = wholeTestInsertions(root, before, model, selected, descriptors);
  for (const item of insertions.sort((a, b) => b.position - a.position))
    after = after.slice(0, item.position) + item.text + after.slice(item.end ?? item.position);
  let relative = path.relative(path.dirname(path.resolve(root, file.path)), TOOL).replaceAll(path.sep, '/');
  if (path.isAbsolute(relative)) relative = pathToFileURL(TOOL).href;
  else if (!relative.startsWith('.')) relative = './' + relative;
  if (!ownImport)
    after =
      `import { assertParityBindings as ${IMPORT}, assertParityBindingsFromSource as ${SOURCE_IMPORT} } from ${JSON.stringify(relative)};\n` +
      after;
  if (file.fallbackKind !== undefined) after = `// @test-kind unproven: ${file.fallbackReason}\n` + after;
  const digest = jsonHash(descriptors).slice(0, 16);
  if (!model.identifiers.has(SOURCE_IMPORT)) after = appendSourceGuard(after, testBinding, digest, root, file);
  const parsed = describeParitySource(after, file.path);
  check(!parsed.tags.errors.length, 'generated-test-kind-errors');
  for (let index = 0; index < selected.length; index++) {
    const current = registration(parsed, selected[index].spec);
    check(current.kinds.includes('parity'), 'generated-parity-kind-not-effective');
    if (selected[index].old.kinds.includes('security') || selected[index].current.kinds.includes('security'))
      check(current.kinds.includes('security'), 'generated-security-kind-lost');
    check(
      parityAstHash(
        strippedBody(
          current,
          new Set(descriptors[index].originalGuardHashes),
          new Map(),
          descriptors[index].originalCallbackExpression,
          new Set(descriptors[index].retainedUniverseAssertions ?? []),
        ),
      ) === (descriptors[index].guardedBodyAstSha256 ?? descriptors[index].originalBodyAstSha256),
      'generated-body-changed',
    );
  }
  return after;
}

function contextCertificateBinding({ baselineSourceSha256: _old, currentSourceSha256: _current, ...binding }) {
  return binding;
}
/** Runtime guard used by generated tests; no Git history or native access needed. */
function verifyRecordsFixtureMarker({ descriptor, model, row, file }) {
  const binding = descriptor.recordsFixture,
    names = binding.inputBindings;
  check(
    Array.isArray(names) && names.length && names.every((name) => /^[A-Za-z_$][\w$]*$/u.test(name)),
    'invalid-records-fixture-marker',
  );
  const imports = model.ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((part) => part.local.name === RECORDS_IMPORT),
  );
  check(
    imports.length === 1 &&
      imports[0].specifiers.length === 1 &&
      imports[0].specifiers[0].imported?.name === 'assertRecordsFixtureLiterals',
    'invalid-records-fixture-marker',
  );
  const source = imports[0].source.value;
  const resolved = source.startsWith('file:') ? fileURLToPath(source) : path.resolve(path.dirname(file), source);
  check(
    resolved === path.resolve(path.dirname(TOOL), 'parity-records-fixture-slice.mjs'),
    'invalid-records-fixture-marker',
  );
  const body = row.callback.body.body;
  const markers = body.filter(
    (statement) => statement.type === 'ExpressionStatement' && statement.expression?.callee?.name === RECORDS_IMPORT,
  );
  check(markers.length === 1, 'invalid-records-fixture-marker');
  const marker = markers[0],
    index = body.indexOf(marker);
  const expected = parse(`${RECORDS_IMPORT}({${names.join(',')}}, ${JSON.stringify(binding.fixture)});`, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  }).body[0];
  check(
    parityAstHash({ ...marker, expression: canonicalRecordsMarker(marker.expression) }) === binding.markerAstSha256 &&
      parityAstHash(expected) === binding.markerAstSha256 &&
      body[index + 1] &&
      parityAstHash(body[index + 1]) === binding.setupAstSha256,
    'invalid-records-fixture-marker',
  );
  const scopes = analyzeScopes(model.ast, { ecmaVersion: 2022, sourceType: 'module' });
  const refs = scopes.scopes.flatMap((scope) => scope.references),
    moduleScope = scopes.scopes.find((scope) => scope.type === 'module');
  const markerRef = refs.find((ref) => ref.identifier === marker.expression.callee);
  check(
    Object.is(markerRef?.resolved?.defs?.[0]?.parent, imports[0]) &&
      markerRef.resolved.references.every((ref) => {
        let found = false;
        for (const registration of model.registrations)
          for (const statement of registration.callback.body?.body ?? [])
            if (statement.type === 'ExpressionStatement' && statement.expression?.callee === ref.identifier)
              found = true;
        return found;
      }),
    'invalid-records-fixture-marker',
  );
  for (const property of marker.expression.arguments[0].properties) {
    const ref = refs.find((item) => item.identifier === property.value);
    check(
      property.shorthand &&
        ref?.resolved?.scope === moduleScope &&
        ref.resolved.defs.length === 1 &&
        ref.resolved.defs[0].type === 'Variable',
      'invalid-records-fixture-marker',
    );
  }
}

function verifyCoexistingCaseGuard({ descriptor, model, moduleUrl }) {
  const guards = model.ast.body.filter(
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'CallExpression' &&
      node.expression.callee?.name === IMPORT,
  );
  check(SHA.test(descriptor.coexistingCaseGuardSha256) && guards.length === 1, 'changed-coexisting-case-guard');
  const bindings = guardDescriptors(guards[0].expression);
  check(
    bindings.length === 1 &&
      bindings[0].caseSelection &&
      jsonHash(bindings[0]) === descriptor.coexistingCaseGuardSha256,
    'changed-coexisting-case-guard',
  );
  validateParityBindings(moduleUrl, bindings);
}

function verifyCaseSelectionMarker({ descriptor, model, row, file }) {
  const selection = descriptor.caseSelection;
  const body = row.callback.body?.body;
  const markerIndices = Array.isArray(body)
    ? body.flatMap((statement, index) =>
        statement.type === 'ExpressionStatement' && statement.expression?.callee?.name === CASE_IMPORT ? [index] : [],
      )
    : [];
  const markerIndex = markerIndices[0],
    marker = body?.[markerIndex]?.expression;
  const guardedGuidBranch = selection.guardBeforeGuidBranch === true;
  const assertionIndex = guardedGuidBranch ? markerIndex + 2 : markerIndex + 1;
  const sourceGuards = model.ast.body.filter(
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'CallExpression' &&
      node.expression.callee?.name === IMPORT,
  );
  const markerImports = model.ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === CASE_IMPORT),
  );
  const markerImport = markerImports[0];
  const bindingImports = model.ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === IMPORT),
  );
  const bindingImport = bindingImports[0];
  const markerPath = markerImport?.source.value.startsWith('file:')
    ? fileURLToPath(markerImport.source.value)
    : markerImport && path.resolve(path.dirname(file), markerImport.source.value);
  const bindingPath = bindingImport?.source.value.startsWith('file:')
    ? fileURLToPath(bindingImport.source.value)
    : bindingImport && path.resolve(path.dirname(file), bindingImport.source.value);
  check(
    !model.tags.errors.length &&
      !row.callback.async &&
      row.callback.params.length === 0 &&
      markerIndices.length === 1 &&
      markerIndex === body.length - (guardedGuidBranch ? 3 : 2) &&
      (!guardedGuidBranch ||
        (descriptor.caseBodyMigration &&
          body[markerIndex + 1]?.type === 'IfStatement' &&
          body[markerIndex + 1].consequent?.type === 'BlockStatement' &&
          body[markerIndex + 1].consequent.body.at(-1)?.type === 'ReturnStatement' &&
          selection.selected.some((entry) => entry.caseIndex === 138))) &&
      body[assertionIndex].type === 'ReturnStatement' &&
      (descriptor.caseBodyMigration || body.length === 2) &&
      marker?.type === 'CallExpression' &&
      marker.callee?.name === CASE_IMPORT &&
      jsonHash(caseGuardDescriptors(marker)) === jsonHash([descriptor]) &&
      sourceGuards.length === 1 &&
      jsonHash(guardDescriptors(sourceGuards[0].expression)) === jsonHash([descriptor]) &&
      markerImports.length === 1 &&
      markerPath === TOOL &&
      markerImport.specifiers.some(
        (item) =>
          item.type === 'ImportSpecifier' &&
          item.imported.name === 'parityCaseBindings' &&
          item.local.name === CASE_IMPORT,
      ) &&
      bindingImports.length === 1 &&
      bindingPath === TOOL &&
      bindingImport.specifiers.some(
        (item) =>
          item.type === 'ImportSpecifier' &&
          item.imported.name === 'assertParityBindings' &&
          item.local.name === IMPORT,
      ) &&
      Array.isArray(selection.bindings) &&
      jsonHash(row.kinds) === jsonHash(selection.parentKinds) &&
      jsonHash(selection.bindings) ===
        jsonHash(descriptor.caseUniverse.currentCaseBindings ?? descriptor.caseUniverse.caseBindings) &&
      selection.bindings.length === descriptor.caseUniverse.count &&
      new Set(selection.bindings.map(jsonHash)).size === selection.bindings.length &&
      Array.isArray(selection.selected) &&
      selection.selected.length > 0 &&
      selection.selected.every(
        (item, index) =>
          Number.isInteger(item.caseIndex) &&
          item.caseIndex >= 0 &&
          item.caseIndex < selection.bindings.length &&
          (!index || item.caseIndex > selection.selected[index - 1].caseIndex) &&
          Array.isArray(item.factIds) &&
          item.factIds.length &&
          item.factIds.every((id) => descriptor.proofs.some((proof) => proof.facts.some((fact) => fact.id === id))),
      ) &&
      row.assertions.some((item) => item.node === body[assertionIndex].argument) &&
      (!descriptor.caseBodyMigration ||
        (Array.isArray(selection.retainedAssertionHashes) &&
          new Set(selection.retainedAssertionHashes).size === selection.retainedAssertionHashes.length &&
          selection.retainedAssertionHashes.every(
            (hash) => row.assertions.filter((item) => item.sha256 === hash).length === 1,
          ))),
    'changed-case-parity-marker',
  );
}

function verifyProtectedSecurityKind({ model, row }) {
  let security = Boolean(model.tags.fileKinds?.includes('security'));
  for (let ancestor = row; ancestor; ancestor = ancestor.parent)
    if (ancestor.kinds.includes('security')) security = true;
  check(security && row.kinds.includes('security'), 'protected-security-kind-lost');
}

function verifyRegionAssertions({ descriptor, row }) {
  let hashes;
  if (descriptor.originalCallbackExpression) {
    const body = row.callback.body.body,
      call = body[0]?.expression,
      returned = body[1]?.argument;
    check(
      call?.type === 'CallExpression' && call.callee.name === REGION_IMPORT && body[1]?.type === 'ReturnStatement',
      'invalid-region-wrapper',
    );
    check(
      jsonHash(guardDescriptors({ ...call, callee: { type: 'Identifier', name: IMPORT } })) === jsonHash([descriptor]),
      'changed-region-binding',
    );
    const expression = returned?.type === 'AwaitExpression' ? returned.argument : returned;
    check(
      row.assertions.some((assertion) => assertion.node === expression),
      'invalid-region-wrapper',
    );
    hashes = [[parityAstHash(expression)]];
  } else {
    const wrappers = row.callback.body.body.filter(
      (statement) =>
        statement.type === 'BlockStatement' &&
        statement.body[0]?.type === 'ExpressionStatement' &&
        statement.body[0].expression?.type === 'CallExpression' &&
        statement.body[0].expression.callee.name === REGION_IMPORT,
    );
    hashes = wrappers.map((statement) => {
      const call = statement.body[0].expression;
      check(
        jsonHash(guardDescriptors({ ...call, callee: { type: 'Identifier', name: IMPORT } })) ===
          jsonHash([descriptor]),
        'changed-region-binding',
      );
      return statement.body.slice(1).map((item) => {
        const expression = item.expression?.type === 'AwaitExpression' ? item.expression.argument : item.expression;
        check(
          item.type === 'ExpressionStatement' && row.assertions.some((assertion) => assertion.node === expression),
          'invalid-region-wrapper',
        );
        return parityAstHash(expression);
      });
    });
  }
  check(jsonHash(hashes) === jsonHash(descriptor.regionHashes), 'changed-region-set');
}

function verifyRuntimeDescriptor({ descriptor, model, file, moduleUrl, legacyOriginalGuards }) {
  check(
    typeof descriptor.repositoryRoot === 'string' && !path.isAbsolute(descriptor.repositoryRoot),
    'explicit-repository-root-required',
  );
  const originalGuardHashes = descriptor.originalGuardHashes ?? legacyOriginalGuards;
  check(
    SHA.test(descriptor.moduleContextAstSha256) &&
      Array.isArray(originalGuardHashes) &&
      originalGuardHashes.every((hash) => SHA.test(hash)),
    'module-context-binding-required',
  );
  const root = path.resolve(path.dirname(file), descriptor.repositoryRoot);
  confined(root, path.relative(root, file));
  check(
    Array.isArray(descriptor.importRoles) && Array.isArray(descriptor.inputDependencies),
    'reviewed-import-roles-required',
  );
  verifyRuntimeProofs({ descriptor, root });
  const row = registration(model, descriptor);
  if (descriptor.recordsReviewSha256)
    check(
      descriptor.recordsReviewSha256 === '5a7fcbf242941cfa2b97c8baa9316402b821f33b1f0a7a7c7742b8fbd0ef09e7',
      'records-review-required',
    );
  if (descriptor.recordsFixture) verifyRecordsFixtureMarker({ descriptor, model, row, file });
  if (descriptor.coexistingCaseGuardSha256) verifyCoexistingCaseGuard({ descriptor, model, moduleUrl });
  if (descriptor.caseSelection) verifyCaseSelectionMarker({ descriptor, model, row, file });
  if (descriptor.protectedSecurity) verifyProtectedSecurityKind({ model, row });
  check(jsonHash(row.loopHeaders) === jsonHash(descriptor.loopHeaders), 'changed-loop-header');
  sourceBindings(model, descriptor.sourceBindings);
  if (descriptor.retainedUniverseAssertions)
    retainedUniverseAssertions(
      row,
      row,
      { caseUniverse: descriptor.caseUniverse, retainedUniverseAssertions: descriptor.retainedUniverseAssertions },
      model,
    );
  check(
    parityAstHash(
      strippedBody(
        row,
        new Set(originalGuardHashes),
        new Map(),
        descriptor.originalCallbackExpression,
        new Set(descriptor.retainedUniverseAssertions ?? []),
      ),
    ) === (descriptor.guardedBodyAstSha256 ?? descriptor.originalBodyAstSha256),
    'changed-original-body',
  );
  if (descriptor.regionHashes) verifyRegionAssertions({ descriptor, row });
  for (const hash of descriptor.originalAssertions)
    check(
      row.assertions.some((item) => item.sha256 === hash),
      'changed-original-assertion',
    );
  if (descriptor.isolationRegistrationsAstSha256)
    check(
      SHA.test(descriptor.isolationRegistrationsAstSha256) &&
        isolationRegistrationHash(model, new Set(originalGuardHashes), descriptor.conciseSpecs ?? []) ===
          descriptor.isolationRegistrationsAstSha256,
      'changed-isolation-registrations',
    );
  check(
    moduleContextHash(model, {
      originalGuards: new Set(originalGuardHashes),
      conciseSpecs: descriptor.conciseSpecs ?? [],
      retained: new Set(
        row.assertions
          .filter((item) => descriptor.retainedUniverseAssertions?.includes(item.sha256))
          .map((item) => item.node),
      ),
    }) === descriptor.moduleContextAstSha256,
    'changed-module-context',
  );
}

function collectRuntimeRegionBindings(model) {
  const regionBindings = new Map();
  let allRegionBindings = null;
  function collectRegions(node) {
    if (node.type === 'CallExpression' && node.callee?.name === REGION_IMPORT) {
      const bound = guardDescriptors({ ...node, callee: { type: 'Identifier', name: IMPORT } });
      check(bound.length === 1 && bound[0].regionHashes, 'invalid-region-wrapper');
      const key = bound[0].baselineId;
      check(
        !regionBindings.has(key) || jsonHash(regionBindings.get(key)) === jsonHash(bound[0]),
        'changed-region-binding',
      );
      regionBindings.set(key, bound[0]);
    }
    childNodes(node).forEach(collectRegions);
  }
  collectRegions(model.ast);
  if (regionBindings.size) {
    const top = model.ast.body.filter(
      (statement) =>
        statement.type === 'ExpressionStatement' &&
        statement.expression?.type === 'CallExpression' &&
        statement.expression.callee?.name === IMPORT,
    );
    check(top.length === 1, 'invalid-region-module-guard');
    const bound = guardDescriptors(top[0].expression);
    allRegionBindings = bound;
    check(
      bound.length === regionBindings.size &&
        new Set(bound.map((item) => item.baselineId)).size === bound.length &&
        bound.every(
          (item) =>
            regionBindings.has(item.baselineId) && jsonHash(regionBindings.get(item.baselineId)) === jsonHash(item),
        ),
      'changed-region-module-bindings',
    );
  }
  return allRegionBindings;
}

function verifyRuntimeMemoryContext({
  file,
  model,
  allRegionBindings,
  contextValidationToken,
  moduleUrl,
  legacyOriginalGuards,
}) {
  const contextCacheKey = `${file}\0${model.sourceSha256}`;
  if (
    allRegionBindings?.length &&
    contextValidationToken !== CONTEXT_VALIDATED &&
    !verifiedContextSources.has(contextCacheKey)
  ) {
    validateParityBindings(moduleUrl, allRegionBindings, {
      contextValidationToken: CONTEXT_VALIDATED,
      legacyOriginalGuards,
    });
    const root = path.resolve(path.dirname(file), allRegionBindings[0].repositoryRoot);
    check(
      allRegionBindings.every((descriptor) => path.resolve(path.dirname(file), descriptor.repositoryRoot) === root),
      'memory-context-root-mismatch',
    );
    const fileDescriptor = { path: path.relative(root, file).replaceAll(path.sep, '/') };
    const unwrapped = unwrapExistingPartial(root, fileDescriptor, model.source, model, model, CONTEXT_VALIDATED);
    check(unwrapped?.source, 'memory-context-verified-unwrap-required');
    const current = describeParitySource(unwrapped.source, fileDescriptor.path);
    const entries = allRegionBindings.map((descriptor) => ({ descriptor, row: registration(current, descriptor) }));
    const anchorIds = new Set();
    for (const { descriptor, row } of entries) {
      const implementationSources = descriptor.importRoles
        .filter((role) => role.role === 'implementation-under-test')
        .map((role) => role.source);
      const anchor = analyzeMemoryRendererSlice({
        ast: current.ast,
        selected: [{ old: row }],
        root,
        filePath: fileDescriptor.path,
        implementationSources,
      });
      if (anchor.requiresAllRegistrations) anchorIds.add(descriptor.baselineId);
    }
    verifyRuntimeMemoryCertificates({ anchorIds, entries, current });
    if (verifiedContextSources.size >= 32) verifiedContextSources.clear();
    verifiedContextSources.add(contextCacheKey);
  }
}

function verifyRuntimeProofs({ descriptor, root }) {
  for (const dependency of descriptor.inputDependencies)
    check(
      SHA.test(dependency.sha256) && parityHash(fs.readFileSync(confined(root, dependency.path))) === dependency.sha256,
      'changed-test-input-dependency',
    );
  for (const proof of descriptor.proofs) prove(root, proof, { supplementalWitness: descriptor.supplementalWitness });
}
function verifyRuntimeMemoryCertificates({ anchorIds, entries, current }) {
  if (anchorIds.size || entries.some(({ descriptor }) => descriptor.memoryContextCertificates?.length)) {
    check(anchorIds.size > 0, 'memory-context-protected-anchor-required');
    for (const { descriptor, row } of entries) {
      if (anchorIds.has(descriptor.baselineId)) continue;
      const expected = descriptor.memoryContextCertificates;
      const hashes = descriptor.regionHashes.flat();
      check(
        Array.isArray(expected) &&
          expected.length === hashes.length &&
          hashes.every((hash) => expected.some((item) => item.assertionSha256 === hash)),
        'memory-context-certificate-required',
      );
      const baselineView = {
        ...current,
        registrations: current.registrations.map((item) =>
          item === row ? { ...item, id: descriptor.baselineId } : item,
        ),
      };
      const implementationSources = descriptor.importRoles
        .filter((role) => role.role === 'implementation-under-test')
        .map((role) => role.source);
      for (const certificate of expected) {
        check(
          certificate.baselineId === descriptor.baselineId &&
            certificate.moduleIsolationRequired === true &&
            certificate.nativeParityProven === false,
          'memory-context-certificate-binding',
        );
        const actual = certifyMemoryContextSlice({
          baselineModel: baselineView,
          currentModel: current,
          baselineId: descriptor.baselineId,
          assertionSha256: certificate.assertionSha256,
          implementationSources,
        });
        check(
          jsonHash(contextCertificateBinding(actual)) === jsonHash(certificate),
          'memory-context-certificate-drift',
        );
      }
    }
  }
}
function validateParityBindings(moduleUrl, descriptors, { legacyOriginalGuards, contextValidationToken } = {}) {
  const file = fileURLToPath(moduleUrl),
    model = describeParitySource(fs.readFileSync(file, 'utf8'), file);
  const allRegionBindings = collectRuntimeRegionBindings(model);
  for (const descriptor of descriptors)
    verifyRuntimeDescriptor({ descriptor, model, file, moduleUrl, legacyOriginalGuards });
  verifyRuntimeMemoryContext({
    file,
    model,
    allRegionBindings,
    contextValidationToken,
    moduleUrl,
    legacyOriginalGuards,
  });
}
/** Runtime guard used by generated tests; legacy overrides are restricted to migration preflight. */
export function assertParityBindings(moduleUrl, descriptors) {
  validateParityBindings(moduleUrl, descriptors);
}
/** Source-bound guard for the reviewed 68-case scalar reader migration. */
export function assertQueryParityBindings(moduleUrl, descriptors) {
  check(
    Array.isArray(descriptors) && descriptors.length === 1 && descriptors[0]?.kind === 'query-reader-matrix-v1',
    'invalid-query-bindings',
  );
  const file = fileURLToPath(moduleUrl),
    tree = parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }),
    descriptor = descriptors[0];
  const imports = tree.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === QUERY_IMPORT),
  );
  const guards = tree.body.filter(
    (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === QUERY_IMPORT,
  );
  const data = tree.body.filter(
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.kind === 'const' &&
      node.declarations.length === 1 &&
      node.declarations[0].id?.name === '__paqQueryDescriptor',
  );
  check(
    imports.length === 1 &&
      guards.length === 1 &&
      data.length === 1 &&
      tree.body[0] === imports[0] &&
      tree.body[1] === data[0] &&
      tree.body[2] === guards[0] &&
      imports[0].specifiers.length === 3 &&
      imports[0].specifiers.some(
        (item) => item.imported?.name === 'assertQueryParityBindings' && item.local.name === QUERY_IMPORT,
      ) &&
      imports[0].specifiers.some(
        (item) => item.imported?.name === 'assertQueryCase' && item.local.name === '__paqQueryCase',
      ) &&
      imports[0].specifiers.some(
        (item) => item.imported?.name === 'assertQueryCompletion' && item.local.name === '__paqQueryComplete',
      ) &&
      path.resolve(path.dirname(file), imports[0].source.value) === TOOL &&
      jsonHash(guardDescriptors({ ...guards[0].expression, callee: { type: 'Identifier', name: IMPORT } })) ===
        jsonHash(descriptors),
    'invalid-query-bindings',
  );
  const declarationCall = {
    ...guards[0].expression,
    callee: { type: 'Identifier', name: IMPORT },
    arguments: [
      guards[0].expression.arguments[0],
      { type: 'ArrayExpression', elements: [data[0].declarations[0].init] },
    ],
  };
  check(
    jsonHash(guardDescriptors(declarationCall)[0]) === descriptor.queryDescriptorSha256 &&
      parityAstHash({
        ...tree,
        body: tree.body.filter((node) => node !== imports[0] && node !== guards[0] && node !== data[0]),
      }) === descriptor.sourceAstSha256,
    'changed-query-source',
  );
  const root = path.resolve(path.dirname(file), descriptor.repositoryRoot);
  check(
    path.resolve(root, 'mirage/test') === path.dirname(path.resolve(file)) &&
      parityHash(fs.readFileSync(confined(root, 'scripts/parity-query-universe.mjs'))) === descriptor.helperSha256 &&
      Array.isArray(descriptor.proofs) &&
      descriptor.proofs.length > 0,
    'changed-query-input',
  );
  for (const proof of descriptor.proofs) prove(root, proof);
}
export function assertQueryCase(cases, index, binding, descriptor) {
  const array = (items, length) =>
    Array.isArray(items) &&
    Object.getPrototypeOf(items) === Array.prototype &&
    items.length === length &&
    Reflect.ownKeys(items).length === length + 1 &&
    Array.from({ length }, (_, i) => Object.getOwnPropertyDescriptor(items, String(i))).every(
      (property) =>
        property &&
        Object.hasOwn(property, 'value') &&
        property.writable &&
        property.enumerable &&
        property.configurable,
    );
  check(
    descriptor &&
      array(cases, 63) &&
      array(descriptor.universe, 63) &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < 63 &&
      cases.every((entry) => array(entry, 4)) &&
      jsonHash(cases) === jsonHash(descriptor.universe) &&
      jsonHash(binding) === jsonHash(descriptor.universe[index]),
    'changed-query-universe',
  );
}
export function assertQueryCompletion(count, descriptor) {
  check(
    count === 63 && Array.isArray(descriptor?.universe) && descriptor.universe.length === 63,
    'incomplete-query-universe',
  );
}
export function assertSoapParityBindings(moduleUrl, descriptors) {
  check(
    Array.isArray(descriptors) && descriptors.length === 1 && descriptors[0]?.kind === 'soap-assertion-loop-v1',
    'invalid-soap-bindings',
  );
  const file = fileURLToPath(moduleUrl),
    tree = parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }),
    descriptor = descriptors[0];
  const imports = tree.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === SOAP_IMPORT),
  );
  const guards = tree.body.filter(
    (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === SOAP_IMPORT,
  );
  const data = tree.body.filter(
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.kind === 'const' &&
      node.declarations.length === 1 &&
      node.declarations[0].id?.name === '__paqSoapDescriptor',
  );
  check(
    imports.length === 1 &&
      guards.length === 1 &&
      data.length === 1 &&
      tree.body[2] === data[0] &&
      tree.body[1] === imports[0] &&
      tree.body[3] === guards[0] &&
      imports[0].specifiers.length === 1 &&
      imports[0].specifiers[0].imported?.name === 'assertSoapParityBindings' &&
      path.resolve(path.dirname(file), imports[0].source.value) === TOOL &&
      jsonHash(guardDescriptors({ ...guards[0].expression, callee: { type: 'Identifier', name: IMPORT } })) ===
        jsonHash(descriptors),
    'invalid-soap-bindings',
  );
  check(
    parityAstHash({
      ...tree,
      body: tree.body.filter((node) => node !== imports[0] && node !== guards[0] && node !== data[0]),
    }) === descriptor.sourceAstSha256,
    'changed-soap-source',
  );
  const declarationCall = {
    ...guards[0].expression,
    callee: { type: 'Identifier', name: IMPORT },
    arguments: [
      guards[0].expression.arguments[0],
      { type: 'ArrayExpression', elements: [data[0].declarations[0].init] },
    ],
  };
  check(jsonHash(guardDescriptors(declarationCall)[0]) === descriptor.loopDescriptorSha256, 'changed-soap-descriptor');
  const root = path.resolve(path.dirname(file), descriptor.repositoryRoot);
  check(
    path.resolve(root, 'mirage/test') === path.dirname(path.resolve(file)) &&
      parityHash(fs.readFileSync(confined(root, 'scripts/parity-assertion-loop.mjs'))) === descriptor.helperSha256 &&
      Array.isArray(descriptor.proofs) &&
      descriptor.proofs.length === 1,
    'changed-soap-input',
  );
  for (const proof of descriptor.proofs) prove(root, proof);
}
export function assertScalarParityBindings(moduleUrl, descriptors) {
  check(
    Array.isArray(descriptors) && descriptors.length === 1 && descriptors[0]?.kind === 'scalar-reader-migration-v1',
    'invalid-scalar-bindings',
  );
  const file = fileURLToPath(moduleUrl),
    source = fs.readFileSync(file, 'utf8');
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }),
    descriptor = descriptors[0];
  const imports = tree.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === SCALAR_IMPORT),
  );
  const guards = tree.body.filter(
    (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === SCALAR_IMPORT,
  );
  check(
    imports.length === 1 &&
      guards.length === 1 &&
      tree.body[0] === imports[0] &&
      tree.body[1] === guards[0] &&
      imports[0].specifiers.length === 1 &&
      imports[0].specifiers[0].imported?.name === 'assertScalarParityBindings' &&
      path.resolve(path.dirname(file), imports[0].source.value) === TOOL &&
      jsonHash(guardDescriptors({ ...guards[0].expression, callee: { type: 'Identifier', name: IMPORT } })) ===
        jsonHash(descriptors),
    'invalid-scalar-bindings',
  );
  check(
    parityAstHash({ ...tree, body: tree.body.filter((node) => node !== imports[0] && node !== guards[0]) }) ===
      descriptor.sourceAstSha256,
    'changed-scalar-source',
  );
  const root = path.resolve(path.dirname(file), descriptor.repositoryRoot);
  check(
    path.resolve(root, 'mirage/test') === path.dirname(path.resolve(file)) &&
      descriptor.producerPath === 'mirage/testing/webapi-contract.mjs' &&
      descriptor.fixturePath === 'mirage/test/fixtures/webapi-native-scalar-reader.json' &&
      parityHash(fs.readFileSync(confined(root, descriptor.producerPath))) === descriptor.producerSha256 &&
      parityHash(fs.readFileSync(confined(root, descriptor.fixturePath))) === descriptor.fixtureSha256 &&
      parityHash(fs.readFileSync(confined(root, 'scripts/parity-scalar-migration.mjs'))) === descriptor.helperSha256 &&
      Array.isArray(descriptor.proofs) &&
      descriptor.proofs.length === 1,
    'changed-scalar-input',
  );
  for (const proof of descriptor.proofs) prove(root, proof);
}
/** Synchronous case guard; unmatched original cases execute unchanged and receive no credit. */
export function parityCaseBindings(moduleUrl, cases, indices, binding, descriptors) {
  check(Array.isArray(descriptors) && descriptors.length === 1, 'invalid-case-parity-binding');
  assertParityBindings(moduleUrl, descriptors);
  const selection = descriptors[0].caseSelection;
  check(
    selection &&
      Array.isArray(cases) &&
      Array.isArray(selection.bindings) &&
      Array.isArray(selection.names) &&
      selection.names.length > 0 &&
      jsonHash(indices) === jsonHash(selection.selected.map((item) => item.caseIndex)),
    'invalid-case-parity-binding',
  );
  const bindings = cases.map((item) => {
    const values = selection.names.length === 1 ? [item] : item;
    check(Array.isArray(values) && values.length === selection.names.length, 'changed-case-parity-universe');
    return Object.fromEntries(selection.names.map((name, index) => [name, values[index]]));
  });
  check(
    jsonHash(bindings) === jsonHash(selection.bindings) && new Set(bindings.map(jsonHash)).size === bindings.length,
    'changed-case-parity-universe',
  );
  const index = bindings.findIndex((item) => jsonHash(item) === jsonHash(binding));
  check(index >= 0, 'unknown-case-parity-binding');
  return indices.includes(index);
}
/** Expected descriptors are read from protected parity bodies, never duplicated in the tooling guard. */
export function assertParityBindingsFromSource(moduleUrl) {
  const file = fileURLToPath(moduleUrl),
    model = describeParitySource(fs.readFileSync(file, 'utf8'), file);
  const descriptors = model.registrations.flatMap((row) =>
    (row.callback.body.type === 'BlockStatement' ? row.callback.body.body : []).flatMap((statement) =>
      statement.type === 'ExpressionStatement' &&
      statement.expression.type === 'CallExpression' &&
      statement.expression.callee.name === IMPORT
        ? guardDescriptors(statement.expression)
        : [],
    ),
  );
  check(descriptors.length > 0, 'protected-parity-bindings-required');
  check(new Set(descriptors.map((item) => item.baselineId)).size === descriptors.length, 'duplicate-protected-binding');
  assertParityBindings(moduleUrl, descriptors);
}

/** Validate every file first, then replace each file atomically. Preserve the index. */
export function writeParityQualification(report, { root } = {}) {
  check(!report.pending.length, 'pending-findings-prevent-write');
  root = path.resolve(root ?? path.dirname(path.dirname(TOOL)));
  for (const item of report.changes)
    check(fs.readFileSync(confined(root, item.path), 'utf8') === item.before, 'source-changed-before-write');
  for (const item of report.receiptChanges ?? [])
    check(!fs.existsSync(receiptDestination(root, item.path)), 'cdn-receipt-changed-before-write');
  const written = [];
  try {
    for (const item of [...(report.receiptChanges ?? []), ...report.changes]) {
      const destination = item.before === null ? receiptDestination(root, item.path) : confined(root, item.path),
        temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(destination), '.qualify-parity-')),
        temporary = path.join(temporaryDirectory, 'content');
      try {
        fs.writeFileSync(temporary, item.after, { flag: 'wx' });
        if (item.before === null) {
          fs.linkSync(temporary, destination);
          written.push(item);
          fs.unlinkSync(temporary);
        } else {
          fs.renameSync(temporary, destination);
          written.push(item);
        }
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  } catch (error) {
    // Portable filesystem APIs cannot conditionally replace or remove a path
    // only if it still names the file we wrote. Preserve published files on
    // failure instead of risking overwriting a concurrent author's change.
    if (written.length) error.qualificationPublishedPaths = written.map((item) => item.path);
    throw error;
  }
  return { ...report, mode: 'write' };
}
function publicReport(report) {
  return Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'changes' && key !== 'receiptChanges'));
}
function pendingConflict(destination, proposed) {
  let existing;
  try {
    existing = fs.readFileSync(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { path: destination, reason: 'existing-finding-changed-preserved', proposedSha256: parityHash(proposed) };
  }
  if (existing.equals(Buffer.from(proposed))) return null;
  return {
    path: destination,
    reason: 'existing-finding-differs-preserved',
    existingSha256: parityHash(existing),
    proposedSha256: parityHash(proposed),
  };
}
export function writeParityPendingFindings(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const conflicts = [];
  for (const finding of report.pending) {
    const destination = path.join(directory, finding.id + '.json'),
      proposed = JSON.stringify(finding, null, 2) + '\n';
    try {
      fs.writeFileSync(destination, proposed, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const conflict = pendingConflict(destination, proposed);
      if (conflict) conflicts.push(conflict);
    }
  }
  return conflicts;
}
function cli(args) {
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/qualify-parity.mjs --manifest <json> [--root <repo>] [--evidence-root <private-dir>] [--security-approval-file <private-json> --security-approval-sha256 <sha256>] [--write] [--pending-dir <dir>]\nDry-run is the default. All original assertions/cases and reviewed independent evidence must be explicitly mapped.\n',
    );
    return;
  }
  const option = (name) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args[at + 1];
  };
  const manifestFile = option('--manifest');
  check(manifestFile, 'manifest-required');
  const root = path.resolve(option('--root') ?? path.dirname(path.dirname(TOOL)));
  let report = qualifyParityManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), {
    root,
    evidenceRoot: option('--evidence-root'),
    securityApprovalFile: option('--security-approval-file'),
    securityApprovalSha256: option('--security-approval-sha256'),
    caseCandidateFile: option('--case-candidate-file'),
    reviewedCandidateFile: option('--reviewed-candidate-file'),
    recordsReviewFile: option('--records-review-file'),
    recordsReviewedSourceFile: option('--records-reviewed-source-file'),
  });
  if (args.includes('--write') && !report.pending.length) report = writeParityQualification(report, { root });
  else if (args.includes('--write')) report.writeBlocked = true;
  const pendingDirectory = option('--pending-dir');
  if (pendingDirectory) {
    report.pendingConflicts = writeParityPendingFindings(report, pendingDirectory);
  }
  process.stdout.write(JSON.stringify(publicReport(report), null, 2) + '\n');
  if (report.pending.length) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        error: error.qualificationCode ?? 'qualification-failed',
        ...(error.qualificationPublishedPaths ? { publishedPaths: error.qualificationPublishedPaths } : {}),
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
