import { sharedParityDescriptor, SHARED } from './parity-shared-descriptor.mjs';
import { sharedPartialDescriptors } from './parity-shared-partial.mjs';
// Enforces docs/test-kinds.md on test files a change adds or modifies.
//   node scripts/check-test-tags.mjs --staged          pre-commit: the index against HEAD
//   node scripts/check-test-tags.mjs --base <rev>      a branch against <rev> (merge base)
//   node scripts/check-test-tags.mjs --event           CI: the GitHub pull_request/push event range
//   node scripts/check-test-tags.mjs --report          counts per kind over every test file (no failure)
//   node scripts/check-test-tags.mjs <file...>         tag syntax of the named files only
// A changed test file needs a valid kind for every test. Removing or rewriting a line inside a `parity` region
// also needs a `// @parity-evidence: <proof>` line added by the same change. Files listed in scripts/test-kinds-legacy.json
// predate the rule: they are skipped while they carry no @test-kind line at all, and checked in full once one is added.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { queryUniverse } from './parity-query-universe.mjs';
// Ordinary tag checks and no-op hooks run before dependencies are installed.
// Guarded source still requires the parser and fails closed if it is absent.
let parser;
function parse(...args) {
  parser ??= createRequire(import.meta.url)('espree').parse;
  return parser(...args);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KINDS = new Set(['parity', 'observation', 'compatibility', 'unproven', 'contract', 'security', 'tooling']);
const EVIDENCE_KINDS = new Set(['parity', 'observation']);
const TEST_FILE = /\.test\.[cm]?js$/;
const TAG = /^\s*\/\/\s*@test-kind\b(.*)$/;
const TAG_BODY = /^\s+([a-z]+(?:\+[a-z]+)*)\s*:\s*(\S.*)$/;
const TEST_DECLARATION = /^(?:test|it|describe|suite)(?:\.(?:only|skip|todo))?\s*\(/;
const CONTEXT_DECLARATION = /^(?:await\s+)?t\.test\s*\(/;
const LOOP_DECLARATION = /^(?:for\s*\(|\[.*\]\.forEach\()/;
function isDeclaration(line) {
  const text = line.trimStart();
  return TEST_DECLARATION.test(text) || CONTEXT_DECLARATION.test(text) || LOOP_DECLARATION.test(text);
}
function isTopLevelDeclaration(line) {
  return line === line.trimStart() && isDeclaration(line);
}
const FILE_TAG_LINES = 40;
function tagAfterComment(text, index) {
  let next = index + 2;
  while (next < text.length && /\s/u.test(text[next])) next++;
  return text.startsWith('@test-kind', next) && !/\w/u.test(text[next + 10] ?? '');
}
function hasAnyTag(text) {
  let lineStart = true;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (/[\r\n\u2028\u2029]/u.test(character)) {
      lineStart = true;
    } else if (lineStart && /\s/u.test(character)) {
      continue;
    } else if (lineStart && text.startsWith('//', index)) {
      if (tagAfterComment(text, index)) return true;
      lineStart = false;
    } else {
      lineStart = false;
    }
  }
  return false;
}
function normalized(value) {
  if (typeof value === 'bigint') return { $bigint: String(value) };
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['loc', 'range', 'start', 'end', 'raw'].includes(key))
      .map(([key, item]) => [key, normalized(item)]),
  );
}
const astHash = (node) =>
  createHash('sha256')
    .update(JSON.stringify(normalized(node)))
    .digest('hex');

// Marker names in fixture strings and comments are not executable guards.
// A source that cannot be parsed remains conservative: any marker spelling in
// it is treated as potentially executable and the guard parser fails closed.
function markerSyntax(text) {
  if (!text?.includes('__paq')) return { ast: null, identifiers: new Set() };
  try {
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
    const identifiers = new Set();
    function visit(node) {
      if (node.type === 'Identifier' && node.name.startsWith('__paq')) identifiers.add(node.name);
      for (const value of Object.values(node))
        for (const child of Array.isArray(value) ? value : [value]) if (child?.type) visit(child);
    }
    visit(ast);
    return { ast, identifiers };
  } catch {
    return null;
  }
}

function legacyFiles() {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'test-kinds-legacy.json'), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

function git(args, { allowFailure = false } = {}) {
  /* NOSONAR */ const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function property(object, name) {
  if (object?.type !== 'ObjectExpression') return null;
  return object.properties.find(
    (item) => item.type === 'Property' && !item.computed && (item.key.name ?? item.key.value) === name,
  )?.value;
}

function appendAssertionRegions({ hasMarker, text, lines, regions }) {
  if (hasMarker('__paqParityAssertions')) {
    try {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
      const shared = sharedPartialDescriptors(ast, astHash);
      if (shared)
        regions.push({
          start: shared.declaration.loc.start.line,
          end: shared.declaration.loc.end.line,
          kinds: ['parity'],
          partial: true,
        });
      function visit(node) {
        if (
          node.type === 'BlockStatement' &&
          node.body[0]?.type === 'ExpressionStatement' &&
          node.body[0].expression?.type === 'CallExpression' &&
          node.body[0].expression.callee.name === '__paqParityAssertions'
        )
          regions.push({ start: node.loc.start.line, end: node.loc.end.line, kinds: ['parity'], partial: true });
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.filter((item) => item?.type).forEach(visit);
          else if (value?.type) visit(value);
        }
      }
      visit(ast);
      for (const node of ast.body)
        if (
          (node.type === 'ImportDeclaration' &&
            node.specifiers.some((item) => item.local.name === '__paqParityAssertions')) ||
          (node.type === 'ExpressionStatement' &&
            node.expression.type === 'CallExpression' &&
            node.expression.callee.name === '__paqParityBindings')
        )
          regions.push({ start: node.loc.start.line, end: node.loc.end.line, kinds: ['parity'] });
    } catch {
      // A malformed protected source cannot be silently treated as unproven.
      regions.push({ start: 1, end: lines.length, kinds: ['parity'] });
    }
  }
}

function appendRetainedAssertions(node, descriptor, regions) {
  const retained = property(property(descriptor, 'caseSelection'), 'retainedAssertionHashes');
  if (!retained) return;
  if (
    retained.type !== 'ArrayExpression' ||
    retained.elements.some(
      (item) => item?.type !== 'Literal' || typeof item.value !== 'string' || !/^[a-f0-9]{64}$/u.test(item.value),
    )
  )
    throw new Error('invalid retained assertions');
  const hashes = retained.elements.map((item) => item.value),
    found = [];
  if (new Set(hashes).size !== hashes.length) throw new Error('duplicate retained assertion');
  function retain(item) {
    if (
      item.type === 'ExpressionStatement' &&
      item.expression?.type === 'CallExpression' &&
      hashes.includes(astHash(item.expression))
    )
      found.push(item);
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) value.filter((child) => child?.type).forEach(retain);
      else if (value?.type) retain(value);
    }
  }
  retain(node);
  if (found.length !== hashes.length || new Set(found.map((item) => astHash(item.expression))).size !== hashes.length)
    throw new Error('missing retained assertion');
  for (const item of found)
    regions.push({ start: item.loc.start.line, end: item.loc.end.line, kinds: ['parity'], partial: true });
}

function appendSqlEvaluatorHelperRegions(ast, descriptor, arrayName, regions) {
  if (property(descriptor, 'sqlEvaluator')?.value !== true) return;
  if (arrayName !== 'semanticCases') throw new Error('invalid SQL evaluator guard');
  for (const name of ['run', 'plain', 'rowsOf', 'NOW', 'check', 'makeScan']) {
    const matches = ast.body.filter(
      (item) =>
        (item.type === 'FunctionDeclaration' && item.id?.name === name) ||
        (item.type === 'VariableDeclaration' && item.declarations.some((declaration) => declaration.id?.name === name)),
    );
    if (matches.length !== 1) throw new Error('invalid SQL evaluator helper');
    regions.push({ start: matches[0].loc.start.line, end: matches[0].loc.end.line, kinds: ['parity'], partial: true });
  }
}

function appendCaseGuard(ast, node, index, call, regions) {
  const statement = node.body[index],
    arrayName = call.arguments[1]?.name,
    indices = call.arguments[2],
    next = node.body[index + 1];
  const shared = sharedParityDescriptor(ast);
  const arg =
    call.arguments[4]?.type === 'Identifier' && call.arguments[4].name === SHARED ? shared?.data : call.arguments[4];
  const descriptor = arg?.type === 'ArrayExpression' && arg.elements.length === 1 ? arg.elements[0] : null;
  if (arg?.type !== 'ArrayExpression' || (call.arguments[4]?.type === 'Identifier' && !descriptor))
    throw new Error('invalid shared parity descriptor');
  const guidBranch = property(property(descriptor, 'caseSelection'), 'guardBeforeGuidBranch')?.value === true;
  const protectedAssertion = guidBranch ? node.body[index + 2] : next;
  const declarations = ast.body.flatMap((item) =>
    item.type === 'VariableDeclaration' && item.kind === 'const'
      ? item.declarations.filter((declaration) => declaration.id?.name === arrayName)
      : [],
  );
  if (
    call.arguments.length !== 5 ||
    declarations.length !== 1 ||
    declarations[0].init?.type !== 'ArrayExpression' ||
    indices?.type !== 'ArrayExpression' ||
    !indices.elements.length ||
    !next ||
    (guidBranch &&
      (next.type !== 'IfStatement' ||
        next.consequent?.type !== 'BlockStatement' ||
        next.consequent.body.at(-1)?.type !== 'ReturnStatement')) ||
    !protectedAssertion ||
    !['ExpressionStatement', 'ReturnStatement'].includes(protectedAssertion.type)
  )
    throw new Error('invalid case guard');
  const entries = declarations[0].init.elements;
  const numbers = indices.elements.map((item) => item?.value);
  if (
    numbers.some((number) => !Number.isInteger(number) || number < 0 || number >= entries.length) ||
    new Set(numbers).size !== numbers.length ||
    numbers.some((number, position) => position && number <= numbers[position - 1]) ||
    numbers.some((number) =>
      entries.some(
        (entry, position) =>
          !numbers.includes(position) &&
          entry.loc.start.line <= entries[number].loc.end.line &&
          entry.loc.end.line >= entries[number].loc.start.line,
      ),
    )
  )
    throw new Error('invalid case guard indices');
  if (guidBranch && !numbers.includes(138)) throw new Error('missing guarded GUID case');
  for (const entry of [statement, protectedAssertion, ...numbers.map((number) => entries[number])])
    regions.push({ start: entry.loc.start.line, end: entry.loc.end.line, kinds: ['parity'], partial: true });
  appendSqlEvaluatorHelperRegions(ast, descriptor, arrayName, regions);
  appendRetainedAssertions(node, descriptor, regions);
}

function appendCaseRegions({ hasMarker, text, lines, regions, errors }) {
  if (hasMarker('__paqParityCaseBindings')) {
    try {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
      let guards = 0,
        usedMarker = false;
      function visit(node) {
        if (node.type === 'Identifier' && node.name === '__paqParityCaseBindings') usedMarker = true;
        if (node.type === 'BlockStatement') {
          for (let i = 0; i < node.body.length; i++) {
            const statement = node.body[i],
              call = statement.type === 'ExpressionStatement' && statement.expression;
            if (call?.type !== 'CallExpression' || call.callee?.name !== '__paqParityCaseBindings') continue;
            guards++;
            appendCaseGuard(ast, node, i, call, regions);
          }
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.filter((item) => item?.type).forEach(visit);
          else if (value?.type) visit(value);
        }
      }
      visit(ast);
      if (usedMarker && !guards) throw new Error('missing case guard');
      const shared = sharedParityDescriptor(ast);
      if (shared)
        regions.push({
          start: shared.declaration.loc.start.line,
          end: shared.declaration.loc.end.line,
          kinds: ['parity'],
          partial: true,
        });
      for (const node of ast.body)
        if (
          (node.type === 'ImportDeclaration' &&
            node.specifiers.some((item) => item.local.name === '__paqParityCaseBindings')) ||
          (node.type === 'ExpressionStatement' &&
            node.expression.type === 'CallExpression' &&
            node.expression.callee.name === '__paqParityBindings')
        )
          regions.push({ start: node.loc.start.line, end: node.loc.end.line, kinds: ['parity'], partial: true });
    } catch {
      errors.push('invalid generated case parity guard');
      regions.push({ start: 1, end: lines.length, kinds: ['parity'], partial: true });
    }
  }
}

function appendQueryRegions({ hasMarker, text, lines, regions, errors }) {
  if (hasMarker('__paqQueryBindings')) {
    try {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
      const imports = ast.body.filter(
        (node) =>
          node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === '__paqQueryBindings'),
      );
      const guards = ast.body.filter(
        (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === '__paqQueryBindings',
      );
      const data = ast.body.flatMap((node) =>
        node.type === 'VariableDeclaration'
          ? node.declarations.filter((item) => item.id?.name === '__paqQueryDescriptor')
          : [],
      );

      const selected = property(data[0]?.init, 'selectedIndices');
      const numbers = selected?.type === 'ArrayExpression' ? selected.elements.map((item) => item?.value) : [];
      if (
        imports.length !== 1 ||
        guards.length !== 1 ||
        data.length !== 1 ||
        numbers.length === 0 ||
        numbers.length > 63 ||
        new Set(numbers).size !== numbers.length ||
        numbers.some(
          (number, index) =>
            !Number.isInteger(number) || number < 0 || number >= 63 || (index && number <= numbers[index - 1]),
        )
      )
        throw new Error('invalid query guard');
      const cases = [],
        markers = [],
        completions = [];
      function visit(node, parent) {
        if (node.type === 'VariableDeclarator' && node.id?.name === 'cases') cases.push(node);
        if (node.type === 'ExpressionStatement' && node.expression?.callee?.name === '__paqQueryCase')
          markers.push({ node, parent });
        if (node.type === 'ExpressionStatement' && node.expression?.callee?.name === '__paqQueryComplete')
          completions.push(node);
        for (const value of Object.values(node))
          for (const child of Array.isArray(value) ? value : [value]) if (child?.type) visit(child, node);
      }
      visit(ast, null);
      if (
        cases.length !== 1 ||
        markers.length !== 1 ||
        completions.length !== 1 ||
        markers[0].parent?.type !== 'BlockStatement' ||
        markers[0].parent.body[0] !== markers[0].node
      )
        throw new Error('invalid query markers');
      const rows = queryUniverse(cases[0].init),
        body = markers[0].parent.body;
      const assertions = body.filter(
        (node) =>
          node.type === 'ExpressionStatement' &&
          node.expression?.type === 'CallExpression' &&
          node.expression.callee?.object?.name === 'assert',
      );
      if (
        assertions.length !== 3 ||
        numbers.some((number) =>
          rows.some(
            (entry, index) =>
              !numbers.includes(index) &&
              entry.source.loc.start.line <= rows[number].source.loc.end.line &&
              entry.source.loc.end.line >= rows[number].source.loc.start.line,
          ),
        )
      )
        throw new Error('invalid query assertion region');
      for (const node of [
        imports[0],
        guards[0],
        data[0],
        markers[0].node,
        completions[0],
        ...assertions,
        ...numbers.map((number) => rows[number].source),
      ])
        regions.push({ start: node.loc.start.line, end: node.loc.end.line, kinds: ['parity'], partial: true });
    } catch {
      errors.push('invalid generated query case guard');
      regions.push({ start: 1, end: lines.length, kinds: ['parity'], partial: true });
    }
  }
}

function soapGuardDeclarations(ast) {
  const imports = ast.body.filter(
    (node) =>
      node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === '__paqSoapBindings'),
  );
  const helperImports = ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === '__paqSoapValue'),
  );
  const guards = ast.body.filter(
    (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === '__paqSoapBindings',
  );
  const declarations = ast.body.flatMap((node) =>
    node.type === 'VariableDeclaration'
      ? node.declarations.filter((item) => item.id?.name === '__paqSoapDescriptor')
      : [],
  );
  const values = ast.body.flatMap((node) =>
    node.type === 'VariableDeclaration' ? node.declarations.filter((item) => item.id?.name === 'VALUES') : [],
  );
  if (
    imports.length !== 1 ||
    helperImports.length !== 1 ||
    guards.length !== 1 ||
    declarations.length !== 1 ||
    values.length !== 1 ||
    values[0].init?.type !== 'ArrayExpression' ||
    guards[0].expression.arguments.length !== 2 ||
    guards[0].expression.arguments[1]?.type !== 'ArrayExpression' ||
    guards[0].expression.arguments[1].elements.length !== 1
  )
    throw new Error('invalid soap guard');
  const selected = property(declarations[0].init, 'selectedIndices');
  if (selected?.type !== 'ArrayExpression') throw new Error('missing soap selection');
  const numbers = selected.elements.map((item) => item?.value);
  if (
    !numbers.length ||
    numbers.length > 27 ||
    new Set(numbers).size !== numbers.length ||
    numbers.some(
      (number, index) =>
        !Number.isInteger(number) || number < 0 || number >= 27 || (index && number <= numbers[index - 1]),
    )
  )
    throw new Error('invalid soap selection');
  return { imports, helperImports, guards, declarations, values, numbers };
}

function appendSoapUniverse(values, numbers, regions) {
  let index = 0;
  for (const entry of values[0].init.elements) {
    const width =
      entry?.type === 'SpreadElement' && entry.argument?.callee?.object?.type === 'ArrayExpression'
        ? entry.argument.callee.object.elements.length
        : 1;
    if (numbers.some((number) => number >= index && number < index + width))
      regions.push({ start: entry.loc.start.line, end: entry.loc.end.line, kinds: ['parity'], partial: true });
    index += width;
  }
  if (index !== 27) throw new Error('changed soap universe');
}

function soapGuardMarkers(ast) {
  const marked = [];
  function visit(node, parent) {
    if (
      node.type === 'ExpressionStatement' &&
      ['__paqSoapValue', '__paqSoapComplete'].includes(node.expression?.callee?.name)
    )
      marked.push(node);
    if (node.type === 'CallExpression' && node.callee?.name === '__paqSoapTail' && parent?.type === 'CallExpression')
      marked.push(parent);
    for (const value of Object.values(node))
      for (const child of Array.isArray(value) ? value : [value]) if (child?.type) visit(child, node);
  }
  visit(ast, null);
  const loop = [];
  function findLoop(node) {
    if (node.type === 'ForOfStatement' && node.right?.name === 'VALUES') loop.push(node);
    for (const value of Object.values(node))
      for (const child of Array.isArray(value) ? value : [value]) if (child?.type) findLoop(child);
  }
  findLoop(ast);
  if (
    loop.length !== 1 ||
    marked.length !== 4 ||
    loop[0].body?.body?.length !== 4 ||
    loop[0].body.body[1].expression?.callee?.name !== '__paqSoapValue'
  )
    throw new Error('invalid soap markers');
  return { marked, loop };
}

function appendSoapNamespaceRegions(ast, guard, regions) {
  const descriptor = guard.expression.arguments[1].elements[0],
    metadata = property(descriptor, 'namespaceRegions');
  const imports = ast.body.filter(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.specifiers.some((item) => item.local.name === '__paqSoapNamespaceProof'),
  );
  const blocks = [];
  function visit(node) {
    if (node.type === 'BlockStatement' && node.body[0]?.expression?.callee?.name === '__paqSoapNamespaceProof')
      blocks.push(node);
    for (const value of Object.values(node))
      for (const child of Array.isArray(value) ? value : [value]) if (child?.type) visit(child);
  }
  visit(ast);
  if (!metadata) {
    if (imports.length || blocks.length) throw new Error('unbound SOAP namespace marker');
    return;
  }
  if (
    metadata.type !== 'ArrayExpression' ||
    !metadata.elements.length ||
    imports.length !== 1 ||
    blocks.length !== metadata.elements.length
  )
    throw new Error('invalid SOAP namespace markers');
  const ids = metadata.elements.map((entry) => property(entry, 'factId')?.value);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length)
    throw new Error('invalid SOAP namespace facts');
  const seen = blocks.map((block) => {
    const call = block.body[0].expression;
    if (
      block.body.length !== 2 ||
      block.body[1].type !== 'ExpressionStatement' ||
      call.arguments.length !== 2 ||
      call.arguments[1]?.type !== 'Literal'
    )
      throw new Error('invalid SOAP namespace region');
    return call.arguments[1].value;
  });
  if (new Set(seen).size !== ids.length || ids.some((id) => !seen.includes(id)))
    throw new Error('unbound SOAP namespace fact');
  for (const node of [imports[0], ...blocks])
    regions.push({ start: node.loc.start.line, end: node.loc.end.line, kinds: ['parity'], partial: true });
}

function appendSoapRegions({ hasMarker, text, lines, regions, errors }) {
  if (hasMarker('__paqSoapBindings')) {
    try {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
      const { imports, helperImports, guards, declarations, values, numbers } = soapGuardDeclarations(ast);
      appendSoapUniverse(values, numbers, regions);
      const { marked, loop } = soapGuardMarkers(ast);
      appendSoapNamespaceRegions(ast, guards[0], regions);
      for (const node of [
        imports[0],
        helperImports[0],
        guards[0],
        declarations[0],
        ...marked,
        ...loop[0].body.body.slice(2),
      ])
        regions.push({ start: node.loc.start.line, end: node.loc.end.line, kinds: ['parity'], partial: true });
    } catch {
      errors.push('invalid generated SOAP assertion guard');
      regions.push({ start: 1, end: lines.length, kinds: ['parity'], partial: true });
    }
  }
}

function appendScalarRegions({ hasMarker, text, lines, regions, errors }) {
  if (hasMarker('__paqScalarBindings')) {
    try {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
      const imports = ast.body.filter(
        (node) =>
          node.type === 'ImportDeclaration' &&
          node.specifiers.some((item) => item.local.name === '__paqScalarBindings'),
      );
      const guards = ast.body.filter(
        (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === '__paqScalarBindings',
      );
      if (
        imports.length !== 1 ||
        guards.length !== 1 ||
        ast.body[0] !== imports[0] ||
        ast.body[1] !== guards[0] ||
        imports[0].specifiers.length !== 1 ||
        imports[0].specifiers[0].imported?.name !== 'assertScalarParityBindings' ||
        guards[0].expression.arguments.length !== 2 ||
        guards[0].expression.arguments[1]?.type !== 'ArrayExpression' ||
        guards[0].expression.arguments[1].elements.length !== 1
      )
        throw new Error('invalid scalar guard');
      for (const node of [imports[0], guards[0]])
        regions.push({ start: node.loc.start.line, end: node.loc.end.line, kinds: ['parity'], partial: true });
    } catch {
      errors.push('invalid generated scalar parity guard');
      regions.push({ start: 1, end: lines.length, kinds: ['parity'], partial: true });
    }
  }
}

/** Parses tags: { fileKinds, regions: [{ start, end, kinds }], errors }. Lines are 1-based. */
export function parseTestKinds(text) {
  const syntax = markerSyntax(text);
  const hasMarker = (name) => (syntax ? syntax.identifiers.has(name) : text.includes(name));
  const lines = text.split(/\r?\n/);
  const errors = [],
    tags = [];
  lines.forEach((line, index) => {
    const match = TAG.exec(line);
    if (!match) return;
    const body = TAG_BODY.exec(match[1]);
    if (!body) return errors.push(`line ${index + 1}: malformed @test-kind (use "// @test-kind <kind>: <reason>")`);
    const kinds = body[1].split('+');
    const unknown = kinds.filter((kind) => !KINDS.has(kind));
    if (unknown.length) errors.push(`line ${index + 1}: unknown kind ${unknown.join(', ')}`);
    const reason = body[2].trim();
    const minimum = kinds.some((kind) => EVIDENCE_KINDS.has(kind)) ? 20 : 8;
    if (reason.length < minimum)
      errors.push(`line ${index + 1}: ${kinds.join('+')} needs a ${minimum > 8 ? 'evidence source' : 'reason'}`);
    // A tag directly above a test declaration (other comment lines may sit between) is per-test.
    let next = index + 1;
    while (next < lines.length && /^\s*(?:\/\/|$)/.test(lines[next])) next++;
    tags.push({
      line: index + 1,
      kinds,
      perTest: next < lines.length && isDeclaration(lines[next]),
      declaration: next + 1,
    });
  });
  const fileTags = tags.filter((tag) => !tag.perTest);
  for (const tag of fileTags)
    if (tag.line > FILE_TAG_LINES)
      errors.push(`line ${tag.line}: a file-level @test-kind belongs in the first ${FILE_TAG_LINES} lines`);
  if (fileTags.length > 1) errors.push('more than one file-level @test-kind');
  const topLevel = lines.flatMap((line, index) => (isTopLevelDeclaration(line) ? [index + 1] : []));
  // A per-test region ends before the next declaration at the same or a shallower indentation, so a tag on an
  // indented it() inside describe() covers only that test.
  const indent = (line) => /^\s*/.exec(lines[line - 1])[0].length;
  const regions = tags
    .filter((tag) => tag.perTest)
    .map((tag) => {
      const depth = indent(tag.declaration);
      const subtest = /^\s*(?:await\s+)?t\.test\s*\(/.test(lines[tag.declaration - 1]);
      const closesSubtest = (line, number) => subtest && indent(number) <= depth && /^\s*\}\);?\s*$/.test(line);
      const end = lines.findIndex(
        (line, index) =>
          index + 1 > tag.declaration &&
          ((isDeclaration(line) && indent(index + 1) <= depth) || closesSubtest(line, index + 1)),
      );
      let endLine = lines.length;
      if (end >= 0) endLine = end + Number(closesSubtest(lines[end], end + 1));
      return {
        start: tag.line,
        end: endLine,
        kinds: tag.kinds,
      };
    });
  // Generated partial regions are lexical blocks, never whole-test promotions.
  // Protect the guard, original statements, and independently executed source guard.
  appendAssertionRegions({ hasMarker, text, lines, regions, errors });
  // A case guard protects only its mapped input entries and the shared statement;
  // the loop and the unmatched entries retain their original kind.
  appendCaseRegions({ hasMarker, text, lines, regions, errors });
  appendQueryRegions({ hasMarker, text, lines, regions, errors });
  appendSoapRegions({ hasMarker, text, lines, regions, errors });
  appendScalarRegions({ hasMarker, text, lines, regions, errors });
  const fileKinds = fileTags[0]?.kinds ?? null;
  if (!fileKinds)
    for (const line of topLevel)
      if (!regions.some((region) => line >= region.start && line <= region.end))
        errors.push(`line ${line}: test has no @test-kind (add a file-level tag or one above the test)`);
  return { fileKinds, regions, errors };
}

// The innermost region (an it() inside a tagged describe()) wins.
const kindsAt = (parsed, line) => {
  const matching = parsed.regions
    .filter((region) => line >= region.start && line <= region.end)
    .sort((a, b) => b.start - a.start);
  const base = matching.find((region) => !region.partial)?.kinds ?? parsed.fileKinds ?? [];
  return matching.some((region) => region.partial)
    ? [...new Set([...base.filter((kind) => kind === 'security'), 'parity'])]
    : base;
};

function isImportMetaUrl(node) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.name === 'url' &&
    node.object?.type === 'MetaProperty' &&
    node.object.meta?.name === 'import' &&
    node.object.property?.name === 'meta'
  );
}

function withoutPositions(value) {
  if (Array.isArray(value)) return value.map(withoutPositions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['range', 'start', 'end'].includes(key))
      .map(([key, item]) => [key, withoutPositions(item)]),
  );
}

function isSourceBindingCall(node) {
  return (
    node?.type === 'CallExpression' &&
    !node.optional &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === '__paqParitySourceBindings' &&
    node.arguments.length === 1 &&
    isImportMetaUrl(node.arguments[0])
  );
}

function safeAssertBinding(ast, identifier) {
  const { analyze } = createRequire(import.meta.url)('eslint-scope');
  const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const references = scopes.scopes.flatMap((scope) => scope.references);
  const binding = references.find((reference) => reference.identifier === identifier)?.resolved;
  const definition = binding?.defs[0];
  if (
    binding?.defs.length !== 1 ||
    definition?.type !== 'ImportBinding' ||
    definition.parent?.source?.value !== 'node:assert/strict' ||
    definition.node?.type !== 'ImportDefaultSpecifier' ||
    binding.references.some((reference) => reference.isWrite())
  )
    return false;
  const parents = new Map();
  function visit(node, parent) {
    if (!node?.type) return;
    parents.set(node, parent);
    for (const value of Object.values(node))
      for (const child of Array.isArray(value) ? value : [value]) if (child?.type) visit(child, node);
  }
  visit(ast, null);
  return binding.references.every((reference) => {
    const member = parents.get(reference.identifier),
      call = parents.get(member);
    return (
      member?.type === 'MemberExpression' &&
      member.object === reference.identifier &&
      !member.computed &&
      call?.type === 'CallExpression' &&
      call.callee === member
    );
  });
}

function canonicalSourceGuard(ast, node) {
  const call = node?.type === 'ExpressionStatement' && node.expression;
  const callback = call?.arguments?.[1],
    statement = callback?.body?.body?.[0];
  if (
    call?.type !== 'CallExpression' ||
    call.callee?.name !== 'test' ||
    call.arguments.length !== 2 ||
    call.arguments[0]?.type !== 'Literal' ||
    !/^parity source bindings [a-f0-9]{16}$/u.test(call.arguments[0].value ?? '') ||
    callback?.type !== 'ArrowFunctionExpression' ||
    callback.async ||
    callback.params.length !== 0 ||
    callback.body?.type !== 'BlockStatement' ||
    callback.body.body.length !== 1 ||
    statement?.type !== 'ExpressionStatement'
  )
    return null;
  let inner = statement.expression,
    form = 'direct';
  if (!isSourceBindingCall(inner)) {
    form = 'assertion';
    const wrapper = inner,
      arrow = wrapper?.arguments?.[0];
    if (
      wrapper?.type !== 'CallExpression' ||
      wrapper.optional ||
      wrapper.callee?.type !== 'MemberExpression' ||
      wrapper.callee.computed ||
      wrapper.callee.property?.name !== 'doesNotThrow' ||
      wrapper.callee.object?.type !== 'Identifier' ||
      wrapper.arguments.length !== 1 ||
      arrow?.type !== 'ArrowFunctionExpression' ||
      arrow.async ||
      arrow.params.length !== 0 ||
      !isSourceBindingCall(arrow.body) ||
      !safeAssertBinding(ast, wrapper.callee.object)
    )
      return null;
    inner = arrow.body;
  }
  const normalizedGuard = structuredClone(call);
  normalizedGuard.arguments[1].body.body[0].expression = structuredClone(inner);
  return { form, start: call.start, original: normalizedGuard, structure: withoutPositions(normalizedGuard) };
}

function topLevelSourceGuards(text) {
  const syntax = markerSyntax(text);
  const hasMarker = (name) => (syntax ? syntax.identifiers.has(name) : text?.includes(name));
  if (
    !hasMarker('__paqParityAssertions') &&
    !hasMarker('__paqParityCaseBindings') &&
    !hasMarker('__paqParitySourceBindings')
  )
    return { partial: [], whole: [] };
  try {
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', range: true });
    const statements = ast.body.filter((node) => node.type !== 'ImportDeclaration');
    const guard = (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      node.expression.callee.name === '__paqParityBindings';
    const partial =
      hasMarker('__paqParityAssertions') || hasMarker('__paqParityCaseBindings') ? statements.filter(guard) : [];
    if (statements.slice(0, partial.length).some((node) => !guard(node))) return null;
    const whole = statements.map((node) => canonicalSourceGuard(ast, node)).filter(Boolean);
    let calls = 0;
    function visit(node) {
      if (!node?.type) return;
      if (node.type === 'CallExpression' && node.callee?.name === '__paqParitySourceBindings') calls++;
      for (const value of Object.values(node))
        for (const child of Array.isArray(value) ? value : [value]) if (child?.type) visit(child);
    }
    visit(ast);
    if (calls !== whole.length) return null;
    return { partial: partial.map((node) => node.expression), whole };
  } catch {
    return null;
  }
}

function matchingSourceGuards(before, after) {
  if (!after || JSON.stringify(before.partial) !== JSON.stringify(after.partial)) return false;
  if (before.whole.length !== after.whole.length) return false;
  let offset = 0;
  for (let index = 0; index < before.whole.length; index++) {
    const old = before.whole[index],
      current = after.whole[index];
    if (current.start !== old.start + offset) return false;
    if (old.form === current.form) {
      if (JSON.stringify(old.original) !== JSON.stringify(shiftSourcePositions(current.original, -offset)))
        return false;
      continue;
    }
    if (JSON.stringify(old.structure) !== JSON.stringify(current.structure)) return false;
    offset += current.original.end - current.start - (old.original.end - old.start);
  }
  return true;
}

function shiftSourcePositions(value, offset, key = '') {
  if (key === 'range') return value.map((position) => position + offset);
  if ((key === 'start' || key === 'end') && typeof value === 'number') return value + offset;
  if (Array.isArray(value)) return value.map((item) => shiftSourcePositions(item, offset));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, shiftSourcePositions(item, offset, name)]),
  );
}

/** Old-side line numbers a unified -U0 diff removes or rewrites, and whether it adds a @parity-evidence line. */
export { kindsAt };
export function diffFacts(diff) {
  const removed = [];
  let evidence = false;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (hunk) {
      const start = Number(hunk[1]),
        count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) removed.push(start + i);
    } else if (/^\+(?!\+\+)/.test(line) && /\/\/\s*@parity-evidence:\s*\S{3}/.test(line)) evidence = true;
  }
  return { removed, evidence };
}

function checkFile(file, { newText, oldText, diffOf, legacy }, failures) {
  const text = newText(file);
  const old = oldText?.(file);
  const before = old == null ? null : parseTestKinds(old);
  const facts = old == null ? null : diffFacts(diffOf(file));
  const touched = facts?.removed.filter((line) => kindsAt(before, line).includes('parity')) ?? [];
  const oldGuards = topLevelSourceGuards(old);
  const newGuards = topLevelSourceGuards(text);
  if (
    (oldGuards?.partial.length || oldGuards?.whole.length) &&
    !matchingSourceGuards(oldGuards, newGuards) &&
    !facts.evidence
  )
    failures.push(
      `${file}: a generated parity source guard is no longer executed at module level; new parity evidence is required.`,
    );
  if (touched.length && !facts.evidence) {
    const first = touched.slice(0, 5).join(', ');
    const more = touched.length > 5 ? ', ...' : '';
    failures.push(
      `${file}: changes ${touched.length} line(s) of a parity test (old lines ${first}${more}). ` +
        'Parity assertions change only with an explicit user request or new native/official-package proof; add "// @parity-evidence: <proof>" (docs/test-kinds.md).',
    );
  }
  if (text == null || (legacy.has(file) && !hasAnyTag(text))) return;
  const parsed = parseTestKinds(text);
  for (const error of parsed.errors) failures.push(`${file}: ${error}`);
}

export function check({ files, newText, oldText, diffOf, legacy = new Set() }) {
  const failures = [];
  for (const file of files.filter((file) => TEST_FILE.test(file)))
    checkFile(file, { newText, oldText, diffOf, legacy }, failures);
  return failures;
}

function run(args) {
  if (args[0] === '--report') {
    return reportKinds();
  }
  let options;
  if (args[0] === '--staged') {
    options = {
      files: git(['diff', '--cached', '--name-only', '--diff-filter=AMD', '--no-renames', '-z'])
        .split('\0')
        .filter(Boolean),
      newText: (file) => git(['show', `:${file}`], { allowFailure: true }),
      oldText: (file) => git(['show', `HEAD:${file}`], { allowFailure: true }),
      diffOf: (file) => git(['diff', '--cached', '-U0', '--no-renames', '--', file]),
    };
  } else if (args[0] === '--base' || args[0] === '--event') {
    let base = args[1],
      head = 'HEAD';
    if (args[0] === '--event') {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      base = event.pull_request?.base.sha ?? event.before;
      head = event.pull_request?.head.sha ?? process.env.GITHUB_SHA ?? 'HEAD';
      if (!base || /^0+$/.test(base)) {
        console.log('No comparable base revision; test kinds are checked on the next change.');
        return 0;
      }
    }
    const mergeBase = git(['merge-base', base, head]).trim();
    options = {
      files: git(['diff', '--name-only', '--diff-filter=AMD', '--no-renames', '-z', mergeBase, head])
        .split('\0')
        .filter(Boolean),
      newText: (file) => git(['show', `${head}:${file}`], { allowFailure: true }),
      oldText: (file) => git(['show', `${mergeBase}:${file}`], { allowFailure: true }),
      diffOf: (file) => git(['diff', '-U0', '--no-renames', mergeBase, head, '--', file]),
    };
  } else {
    options = { files: args, newText: (file) => fs.readFileSync(path.resolve(root, file), 'utf8') };
  }
  const failures = check({ ...options, legacy: legacyFiles() });
  for (const failure of failures) console.error(failure);
  if (failures.length) {
    console.error(`${failures.length} test-kind problem(s); see docs/test-kinds.md.`);
    return 1;
  }
  console.log(
    `Test kinds valid for ${options.files.filter((file) => TEST_FILE.test(file)).length} changed test file(s).`,
  );
  return 0;
}

function reportKinds() {
  const files = git(['ls-files', '-z'])
    .split('\0')
    .filter((file) => TEST_FILE.test(file));
  const counts = {};
  for (const file of files) {
    const parsed = parseTestKinds(fs.readFileSync(path.join(root, file), 'utf8'));
    const kinds = new Set([...(parsed.fileKinds ?? []), ...parsed.regions.flatMap((region) => region.kinds)]);
    if (!kinds.size) kinds.add('untagged');
    for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  console.log(JSON.stringify({ files: files.length, counts }, null, 1));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = run(process.argv.slice(2));
