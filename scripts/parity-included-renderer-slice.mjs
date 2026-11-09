import { hashAst as hash, isLiteralNode as literal } from './parity-ast-utils.mjs';
// Source-only certificate for the narrowly reviewed fresh included-template helper.
// This proves no native behavior; proof/context equivalence remains the caller's job.
import { createRequire } from 'node:module';
import { assertPureFixtureBootstrap } from './parity-generated-fixtures.mjs';

const { parse } = createRequire(import.meta.url)('espree');
const { analyze } = createRequire(import.meta.url)('eslint-scope');
const check = (value) => {
  if (!value) throw new Error('unsupported-included-renderer-slice');
};
const helperSource = `function nativeInclude() {
  return (source, data = {}) => createPortalRenderer({
    templates: { proof: { id: 'proof', name: 'proof', source } },
    snippets: {}, settings: {}, pages: [], webFiles: [], records: [], weblinks: {}, sitemarkers: {}, website: {}, pageTemplates: [],
  }, { observed: {
    liquidRuntimeCompatibility: 'observed', liquidFilterErrors: 'observed', liquidHtmlVoidSerialization: 'html',
    liquidPathAndQueryFragment: 'query', evidence: 'Repeated native 2026-11-08 language include captures; frontend-parity-evidence.json.',
  } }).renderString("{% include 'proof' %}", data);
}`;
const expectedHelper = parse(helperSource, { ecmaVersion: 'latest', sourceType: 'module' }).body[0];
const expectedPlain = parse(
  `function plain() {
  const renderer = createPortalRenderer({ templates: {}, snippets: {}, settings: {}, pages: [], webFiles: [],
    records: [], weblinks: {}, sitemarkers: {}, website: {}, pageTemplates: [] });
  return (source, data = {}) => renderer.renderString(source, data);
}`,
  { ecmaVersion: 'latest', sourceType: 'module' },
).body[0];
const expectedGuard = parse(
  `assert.equal(createHash('sha256').update(nativeInclude.toString()).digest('hex'), '28cbe2a0b49b078d468e95b722040fe7f7c39380564b82f74fa74ef2f36576c4');`,
  { ecmaVersion: 'latest', sourceType: 'module' },
).body[0];
function children(node) {
  return Object.values(node).flatMap((v) => (Array.isArray(v) ? v.filter((x) => x?.type) : v?.type ? [v] : []));
}
function walk(node, visit, parent = null) {
  visit(node, parent);
  for (const child of children(node)) walk(child, visit, node);
}
/** Certify only selected direct, sequential nativeInclude calls with literal inputs. */
export function analyzeIncludedRendererSlice({ ast, selected, implementationSources = [] }) {
  const empty = () => ({
    recognizedIdentifiers: new Set(),
    isolatedIdentifiers: new Set(),
    recognizedBuiltinImports: new Set(),
    handledInputSources: new Set(),
    dependencies: [],
    fixtures: [],
  });
  try {
    check(selected.length > 0);
    assertPureFixtureBootstrap({ ast });
    const helper = ast.body.filter((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'nativeInclude');
    const plain = ast.body.filter((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'plain');
    check(
      helper.length <= 1 &&
        (!helper.length || hash(helper[0]) === hash(expectedHelper)) &&
        plain.length === 1 &&
        hash(plain[0]) === hash(expectedPlain),
    );
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
    const moduleScope = scopes.scopes.find((scope) => scope.type === 'module');
    const refs = new Map();
    for (const scope of scopes.scopes) for (const ref of scope.references) refs.set(ref.identifier, ref.resolved);
    const helperVar = helper.length && moduleScope?.variables.find((item) => item.identifiers.includes(helper[0].id));
    const plainVar = moduleScope?.variables.find((item) => item.identifiers.includes(plain[0].id));
    const renderer = moduleScope?.variables.find((item) => item.name === 'createPortalRenderer');
    check(
      (!helper.length || helperVar) &&
        plainVar &&
        renderer &&
        renderer.defs.length === 1 &&
        renderer.defs[0].type === 'ImportBinding',
    );
    const binding = renderer.defs[0];
    check(
      binding.node.type === 'ImportSpecifier' &&
        binding.node.imported.name === 'createPortalRenderer' &&
        implementationSources.includes(binding.parent.source.value),
    );
    check(!helperVar || !helperVar.references.some((ref) => ref.isWrite() && !ref.init));
    check(!plainVar.references.some((ref) => ref.isWrite() && !ref.init));
    const allowedHelperUses = new Set();
    const fixtures = [];
    for (const { old: row } of selected) {
      const callback = row?.callback;
      check(
        callback?.type === 'ArrowFunctionExpression' &&
          callback.async &&
          !callback.generator &&
          callback.params.length === 0 &&
          callback.body.type === 'BlockStatement' &&
          !row.parent &&
          row.node?.type === 'CallExpression' &&
          row.node.arguments.length === 2 &&
          row.node.arguments[1] === callback &&
          row.node.arguments[0]?.type === 'Literal' &&
          typeof row.node.arguments[0].value === 'string' &&
          (row.loopHeaders?.length ?? 0) === 0 &&
          refs.get(row.node.callee)?.defs?.[0]?.parent?.source?.value === 'node:test',
      );
      const statements = callback.body.body;
      const declarations = statements.filter(
        (s) =>
          s.type === 'VariableDeclaration' &&
          s.kind === 'const' &&
          s.declarations.length === 1 &&
          s.declarations[0].init?.type === 'CallExpression' &&
          [helperVar, plainVar].includes(refs.get(s.declarations[0].init.callee)),
      );
      check(declarations.length === 1);
      const declaration = declarations[0].declarations[0];
      check(declaration.id.type === 'Identifier' && declaration.init.arguments.length === 0);
      const producer = refs.get(declaration.init.callee);
      if (producer === helperVar) allowedHelperUses.add(declaration.init.callee);
      const scope = scopes.acquire(callback);
      const renderVar = scope?.variables.find((item) => item.identifiers.includes(declaration.id));
      check(renderVar && !renderVar.references.some((ref) => ref.isWrite() && !ref.init));
      const calls = [];
      for (const statement of statements) {
        if (statement === declarations[0]) continue;
        if (hash(statement) === hash(expectedGuard)) {
          walk(statement, (node) => {
            if (node.type === 'Identifier' && refs.get(node) === helperVar) allowedHelperUses.add(node);
          });
          continue;
        }
        const assertion = statement.type === 'ExpressionStatement' && statement.expression;
        const member = assertion?.callee;
        const invoke = assertion?.arguments?.[0]?.argument;
        const assertDef = refs.get(member?.object)?.defs?.[0];
        check(
          assertion?.type === 'CallExpression' &&
            member?.type === 'MemberExpression' &&
            !member.computed &&
            member.object.type === 'Identifier' &&
            member.property.name === 'equal' &&
            assertDef?.parent?.source?.value === 'node:assert/strict' &&
            assertDef.node.type === 'ImportDefaultSpecifier' &&
            assertion.arguments.length === 2 &&
            assertion.arguments[0]?.type === 'AwaitExpression' &&
            invoke?.type === 'CallExpression' &&
            invoke.callee.type === 'Identifier' &&
            refs.get(invoke.callee) === renderVar &&
            invoke.arguments.length >= 1 &&
            invoke.arguments.length <= 2 &&
            typeof invoke.arguments[0]?.value === 'string' &&
            invoke.arguments.every(literal) &&
            literal(assertion.arguments[1]),
        );
        calls.push({ inputSha256: hash(invoke.arguments), assertionSha256: hash(assertion) });
      }
      check(calls.length > 0 && renderVar.references.filter((ref) => !ref.init).length === calls.length);
      fixtures.push({
        baselineId: row.id,
        producerKind: producer === helperVar ? 'fresh-included-renderer' : 'plain-renderer',
        helperSha256: hash(producer === helperVar ? helper[0] : plain[0]),
        selectedBodySha256: hash(callback.body),
        calls,
      });
    }
    // The selected cohort must contain every use; the caller must also bind every
    // registration and the module context before crediting any selected test.
    for (const ref of helperVar?.references ?? []) {
      check(ref.init || allowedHelperUses.has(ref.identifier));
    }
    return {
      ...empty(),
      fixtures,
      requiresAllRegistrations: true,
      requiresModuleIsolationProof: true,
      migrationKind: 'fresh-included-renderer',
    };
  } catch {
    return empty();
  }
}
