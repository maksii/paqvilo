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
const DECLARATION =
  /^\s*(?:(?:await\s+)?t\.test\s*\(|(?:test|it|describe|suite)(?:\.(?:only|skip|todo))?\s*\(|for\s*\(|\[.*\]\.forEach\()/;
const TOP_LEVEL =
  /^(?:(?:await\s+)?t\.test\s*\(|(?:test|it|describe|suite)(?:\.(?:only|skip|todo))?\s*\(|for\s*\(|\[.*\]\.forEach\()/;
const FILE_TAG_LINES = 40;
const ANY_TAG = /^[^\S\r\n\u2028\u2029]*\/\/\s*@test-kind\b/m;
const normalized = (value) =>
  typeof value === 'bigint'
    ? { $bigint: String(value) }
    : Array.isArray(value)
      ? value.map(normalized)
      : !value || typeof value !== 'object'
        ? value
        : Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !['loc', 'range', 'start', 'end', 'raw'].includes(key))
              .map(([key, item]) => [key, normalized(item)]),
          );
const astHash = (node) =>
  createHash('sha256')
    .update(JSON.stringify(normalized(node)))
    .digest('hex');

// Marker names in fixture strings and comments are not executable guards.
// A source that cannot be parsed remains conservative: any marker spelling in
// it is treated as potentially executable and the guard parser fails closed.
function markerSyntax(text) {
  if (!text || !text.includes('__paq')) return { ast: null, identifiers: new Set() };
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
      perTest: next < lines.length && DECLARATION.test(lines[next]),
      declaration: next + 1,
    });
  });
  const fileTags = tags.filter((tag) => !tag.perTest);
  for (const tag of fileTags)
    if (tag.line > FILE_TAG_LINES)
      errors.push(`line ${tag.line}: a file-level @test-kind belongs in the first ${FILE_TAG_LINES} lines`);
  if (fileTags.length > 1) errors.push('more than one file-level @test-kind');
  const topLevel = lines.flatMap((line, index) => (TOP_LEVEL.test(line) ? [index + 1] : []));
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
          ((DECLARATION.test(line) && indent(index + 1) <= depth) || closesSubtest(line, index + 1)),
      );
      return {
        start: tag.line,
        end: end >= 0 ? end + (closesSubtest(lines[end], end + 1) ? 1 : 0) : lines.length,
        kinds: tag.kinds,
      };
    });
  // Generated partial regions are lexical blocks, never whole-test promotions.
  // Protect the guard, original statements, and independently executed source guard.
  if (hasMarker('__paqParityAssertions')) {
    try {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
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
  // A case guard protects only its mapped input entries and the shared statement;
  // the loop and the unmatched entries retain their original kind.
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
            const arrayName = call.arguments[1]?.name,
              indices = call.arguments[2],
              next = node.body[i + 1];
            const markerDescriptor =
              call.arguments[4]?.type === 'ArrayExpression' && call.arguments[4].elements.length === 1
                ? call.arguments[4].elements[0]
                : null;
            const property = (object, name) =>
              object?.type === 'ObjectExpression'
                ? object.properties.find(
                    (item) => item.type === 'Property' && !item.computed && (item.key.name ?? item.key.value) === name,
                  )?.value
                : null;
            const guidBranch =
              property(property(markerDescriptor, 'caseSelection'), 'guardBeforeGuidBranch')?.value === true;
            const protectedAssertion = guidBranch ? node.body[i + 2] : next;
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
              throw Error('invalid case guard');
            const entries = declarations[0].init.elements;
            const numbers = indices.elements.map((item) => item?.value);
            if (
              numbers.some((number) => !Number.isInteger(number) || number < 0 || number >= entries.length) ||
              new Set(numbers).size !== numbers.length ||
              numbers.some((number, index) => index && number <= numbers[index - 1]) ||
              numbers.some((number) =>
                entries.some(
                  (entry, index) =>
                    !numbers.includes(index) &&
                    entry.loc.start.line <= entries[number].loc.end.line &&
                    entry.loc.end.line >= entries[number].loc.start.line,
                ),
              )
            )
              throw Error('invalid case guard indices');
            if (guidBranch && !numbers.includes(138)) throw Error('missing guarded GUID case');
            for (const entry of [statement, protectedAssertion, ...numbers.map((number) => entries[number])])
              regions.push({ start: entry.loc.start.line, end: entry.loc.end.line, kinds: ['parity'], partial: true });
            const descriptor = markerDescriptor;
            const retained = property(property(descriptor, 'caseSelection'), 'retainedAssertionHashes');
            if (retained) {
              if (
                retained.type !== 'ArrayExpression' ||
                retained.elements.some(
                  (item) =>
                    item?.type !== 'Literal' || typeof item.value !== 'string' || !/^[a-f0-9]{64}$/u.test(item.value),
                )
              )
                throw Error('invalid retained assertions');
              const hashes = retained.elements.map((item) => item.value),
                found = [];
              if (new Set(hashes).size !== hashes.length) throw Error('duplicate retained assertion');
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
              if (
                found.length !== hashes.length ||
                new Set(found.map((item) => astHash(item.expression))).size !== hashes.length
              )
                throw Error('missing retained assertion');
              for (const item of found)
                regions.push({ start: item.loc.start.line, end: item.loc.end.line, kinds: ['parity'], partial: true });
            }
          }
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.filter((item) => item?.type).forEach(visit);
          else if (value?.type) visit(value);
        }
      }
      visit(ast);
      if (usedMarker && !guards) throw Error('missing case guard');
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
      const property = (object, name) =>
        object?.type === 'ObjectExpression'
          ? object.properties.find(
              (item) => item.type === 'Property' && !item.computed && (item.key.name ?? item.key.value) === name,
            )?.value
          : null;
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
        throw Error('invalid query guard');
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
        throw Error('invalid query markers');
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
        throw Error('invalid query assertion region');
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
  if (hasMarker('__paqSoapBindings')) {
    try {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
      const property = (object, name) =>
        object?.type === 'ObjectExpression'
          ? object.properties.find(
              (item) => item.type === 'Property' && !item.computed && (item.key.name ?? item.key.value) === name,
            )?.value
          : null;
      const imports = ast.body.filter(
        (node) =>
          node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === '__paqSoapBindings'),
      );
      const helperImports = ast.body.filter(
        (node) =>
          node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === '__paqSoapValue'),
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
        throw Error('invalid soap guard');
      const selected = property(declarations[0].init, 'selectedIndices');
      if (selected?.type !== 'ArrayExpression') throw Error('missing soap selection');
      const numbers = selected.elements.map((item) => item?.value);
      if (
        numbers.length !== 21 ||
        new Set(numbers).size !== numbers.length ||
        numbers.some(
          (number, index) =>
            !Number.isInteger(number) || number < 0 || number >= 27 || (index && number <= numbers[index - 1]),
        )
      )
        throw Error('invalid soap selection');
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
      if (index !== 27) throw Error('changed soap universe');
      const marked = [];
      function visit(node, parent) {
        if (
          node.type === 'ExpressionStatement' &&
          ['__paqSoapValue', '__paqSoapComplete'].includes(node.expression?.callee?.name)
        )
          marked.push(node);
        if (
          node.type === 'CallExpression' &&
          node.callee?.name === '__paqSoapTail' &&
          parent?.type === 'CallExpression'
        )
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
        throw Error('invalid soap markers');
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
        throw Error('invalid scalar guard');
      for (const node of [imports[0], guards[0]])
        regions.push({ start: node.loc.start.line, end: node.loc.end.line, kinds: ['parity'], partial: true });
    } catch {
      errors.push('invalid generated scalar parity guard');
      regions.push({ start: 1, end: lines.length, kinds: ['parity'], partial: true });
    }
  }
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
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
    const statements = ast.body.filter((node) => node.type !== 'ImportDeclaration');
    const guard = (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      node.expression.callee.name === '__paqParityBindings';
    const partial =
      hasMarker('__paqParityAssertions') || hasMarker('__paqParityCaseBindings') ? statements.filter(guard) : [];
    if (statements.slice(0, partial.length).some((node) => !guard(node))) return null;
    const whole = statements.filter(
      (node) =>
        node.type === 'ExpressionStatement' &&
        node.expression.type === 'CallExpression' &&
        node.expression.arguments[0]?.type === 'Literal' &&
        /^parity source bindings [a-f0-9]{16}$/u.test(node.expression.arguments[0].value ?? '') &&
        node.expression.arguments.at(-1)?.body?.body?.[0]?.expression?.callee?.name === '__paqParitySourceBindings',
    );
    return { partial: partial.map((node) => node.expression), whole: whole.map((node) => node.expression) };
  } catch {
    return null;
  }
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

export function check({ files, newText, oldText, diffOf, legacy = new Set() }) {
  const failures = [];
  for (const file of files.filter((file) => TEST_FILE.test(file))) {
    const text = newText(file);
    const old = oldText?.(file);
    const before = old == null ? null : parseTestKinds(old);
    const facts = old == null ? null : diffFacts(diffOf(file));
    const touched = facts?.removed.filter((line) => kindsAt(before, line).includes('parity')) ?? [];
    const oldGuards = topLevelSourceGuards(old);
    const newGuards = topLevelSourceGuards(text);
    if (
      (oldGuards?.partial.length || oldGuards?.whole.length) &&
      (!newGuards || JSON.stringify(oldGuards) !== JSON.stringify(newGuards)) &&
      !facts.evidence
    )
      failures.push(
        `${file}: a generated parity source guard is no longer executed at module level; new parity evidence is required.`,
      );
    if (touched.length && !facts.evidence)
      failures.push(
        `${file}: changes ${touched.length} line(s) of a parity test (old lines ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', ...' : ''}). ` +
          'Parity assertions change only with an explicit user request or new native/official-package proof; add "// @parity-evidence: <proof>" (docs/test-kinds.md).',
      );
    if (text == null || (legacy.has(file) && !ANY_TAG.test(text))) continue;
    const parsed = parseTestKinds(text);
    for (const error of parsed.errors) failures.push(`${file}: ${error}`);
  }
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
