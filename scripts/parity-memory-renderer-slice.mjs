import { hashAst as hash, isLiteralNode as literal } from './parity-ast-utils.mjs';
// Source-only classification of a fresh, literal-input renderer test family.
// It does not assert platform parity and does not classify filesystem or network inputs.
import { createRequire } from 'node:module';
import path from 'node:path';
import { assertPureFixtureBootstrap } from './parity-generated-fixtures.mjs';

const { analyze } = createRequire(import.meta.url)('eslint-scope');
const fail = () => {
  throw Object.assign(new Error('unsupported-memory-renderer-slice'), {
    qualificationCode: 'unsupported-memory-renderer-slice',
  });
};
const check = (value) => {
  if (!value) fail();
};
function walk(node, fn, parent = null) {
  fn(node, parent);
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value]) if (child?.type) walk(child, fn, node);
}
/** Infer exact per-original certificates; all registration and module guards remain caller responsibilities. */
export function analyzeMemoryRendererSlice({ ast, selected, root, filePath, implementationSources = [] }) {
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
    check(!ast.body.some((node) => node.type === 'VariableDeclaration'));
    const functions = ast.body.filter((node) => node.type === 'FunctionDeclaration');
    check(functions.length === 1);
    const helper = functions[0];
    check(
      !helper.async &&
        !helper.generator &&
        helper.params.length === 2 &&
        helper.params[0].type === 'Identifier' &&
        helper.params[1].type === 'AssignmentPattern' &&
        helper.params[1].left.type === 'Identifier' &&
        helper.params[1].right.type === 'ObjectExpression' &&
        helper.params[1].right.properties.length === 0 &&
        helper.body.body.length === 1 &&
        helper.body.body[0].type === 'ReturnStatement',
    );
    const call = helper.body.body[0].argument,
      portal = call?.arguments?.[0],
      options = call?.arguments?.[1];
    check(
      call?.type === 'CallExpression' &&
        call.callee?.type === 'Identifier' &&
        call.arguments.length === 2 &&
        portal?.type === 'ObjectExpression' &&
        options?.type === 'Identifier' &&
        options.name === helper.params[1].left.name,
    );
    const observed = portal.properties.filter(
      (item) =>
        item.type === 'Property' && !item.computed && (item.key.name ?? item.key.value) === helper.params[0].name,
    );
    check(
      observed.length === 1 &&
        observed[0].value.type === 'Identifier' &&
        observed[0].value.name === helper.params[0].name,
    );
    check(
      portal.properties.every(
        (item) =>
          item === observed[0] ||
          (item.type === 'Property' &&
            item.kind === 'init' &&
            !item.computed &&
            !item.method &&
            !item.shorthand &&
            !['__proto__', 'constructor', 'prototype'].includes(item.key.name ?? item.key.value) &&
            literal(item.value)),
      ),
    );
    check(new Set(portal.properties.map((item) => item.key.name ?? item.key.value)).size === portal.properties.length);
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }),
      refs = new Map(),
      parents = new Map();
    for (const scope of scopes.scopes) for (const ref of scope.references) refs.set(ref.identifier, ref.resolved);
    walk(ast, (node, parent) => parents.set(node, parent));
    const moduleScope = scopes.scopes.find((scope) => scope.type === 'module');
    const helperVar = moduleScope?.variables.find((item) => item.identifiers.includes(helper.id));
    const sut = refs.get(call.callee);
    check(
      helperVar &&
        sut?.scope === moduleScope &&
        sut.defs.length === 1 &&
        sut.defs[0].type === 'ImportBinding' &&
        implementationSources.includes(sut.defs[0].parent.source.value),
    );
    const verifyImports = () => {
      for (const item of ast.body.filter((node) => node.type === 'ImportDeclaration')) {
        const source = item.source.value;
        if (['node:test', 'node:assert', 'node:assert/strict'].includes(source)) continue;
        if (source === 'node:fs') {
          check(
            item.specifiers.length === 1 &&
              item.specifiers[0].type === 'ImportSpecifier' &&
              item.specifiers[0].imported.name === 'readFileSync',
          );
          continue;
        }
        if (source === 'node:crypto') {
          check(
            item.specifiers.length === 1 &&
              item.specifiers[0].type === 'ImportSpecifier' &&
              item.specifiers[0].imported.name === 'createHash',
          );
          continue;
        }
        if (item === sut.defs[0].parent) {
          check(item.specifiers.length === 1 && item.specifiers[0].type === 'ImportSpecifier');
          continue;
        }
        check(
          typeof root === 'string' &&
            typeof filePath === 'string' &&
            typeof source === 'string' &&
            /^\.\.?\//u.test(source) &&
            !/[?#\\]/u.test(source) &&
            path.resolve(root, path.dirname(filePath), source) === path.resolve(root, 'scripts/qualify-parity.mjs') &&
            item.specifiers.length > 0 &&
            item.specifiers.every(
              (part) =>
                part.type === 'ImportSpecifier' &&
                ['assertParityBindings', 'assertParityBindingsFromSource'].includes(part.imported.name),
            ),
        );
      }
    };
    verifyImports();
    const registrations = ast.body.filter((node) => node.type === 'ExpressionStatement').map((node) => node.expression);
    const testImport = ast.body.filter(
      (node) => node.type === 'ImportDeclaration' && node.source.value === 'node:test',
    );
    check(
      testImport.length === 1 &&
        testImport[0].specifiers.length === 1 &&
        testImport[0].specifiers[0].type === 'ImportDefaultSpecifier',
    );
    const testVar = moduleScope.variables.find((item) => item.name === testImport[0].specifiers[0].local.name);
    check(
      testVar?.references.every((ref) => {
        const parent = parents.get(ref.identifier);
        return parent?.type === 'CallExpression' && parent.callee === ref.identifier && registrations.includes(parent);
      }),
    );
    check(registrations.every((registration) => registration.arguments[1].params.length === 0));
    check(
      helperVar.references.every((ref) => {
        const parent = parents.get(ref.identifier);
        return parent?.type === 'CallExpression' && parent.callee === ref.identifier;
      }),
    );
    const verifyReferences = () => {
      walk(ast, (node) => {
        check(!['AssignmentExpression', 'UpdateExpression', 'ImportExpression'].includes(node.type));
        if (node.type === 'MemberExpression') {
          check(!node.computed || node.property.type === 'Literal');
          check(
            !['constructor', 'prototype', '__proto__'].includes(
              node.computed ? node.property.value : node.property.name,
            ),
          );
        }
        if (node.type === 'ObjectPattern')
          for (const property of node.properties)
            check(
              property.type === 'RestElement' ||
                (property.type === 'Property' &&
                  !property.computed &&
                  !['constructor', 'prototype', '__proto__'].includes(property.key.name ?? property.key.value)),
            );
      });
      for (const [identifier, variable] of refs) {
        if (variable) continue;
        const parent = parents.get(identifier),
          grandparent = parents.get(parent);
        if (identifier.name === 'undefined') continue;
        if (identifier.name === 'JSON') {
          check(
            parent?.type === 'MemberExpression' &&
              !parent.computed &&
              parent.object === identifier &&
              parent.property.name === 'parse' &&
              grandparent?.type === 'CallExpression' &&
              grandparent.callee === parent,
          );
          continue;
        }
        if (identifier.name === 'URL') {
          check(
            parent?.type === 'NewExpression' &&
              parent.callee === identifier &&
              parent.arguments.length === 2 &&
              parent.arguments[0]?.type === 'Literal' &&
              typeof parent.arguments[0].value === 'string' &&
              parent.arguments[0].value.startsWith('./') &&
              !/[?#\\]/u.test(parent.arguments[0].value) &&
              parent.arguments[1]?.type === 'MemberExpression' &&
              !parent.arguments[1].computed &&
              parent.arguments[1].property.name === 'url' &&
              parent.arguments[1].object?.type === 'MetaProperty' &&
              parent.arguments[1].object.meta.name === 'import' &&
              parent.arguments[1].object.property.name === 'meta',
          );
          continue;
        }
        fail();
      }
    };
    verifyReferences();
    const assertions = new Set(
      ast.body
        .filter(
          (node) =>
            node.type === 'ImportDeclaration' && ['node:assert', 'node:assert/strict'].includes(node.source.value),
        )
        .flatMap((node) =>
          node.specifiers.map((part) => moduleScope.variables.find((item) => item.name === part.local.name)),
        ),
    );
    const fixtures = [];
    const certifySelected = (item) => {
      const row = item.old,
        callback = row.callback;
      check(
        registrations.some((registration) => registration.arguments[1] === callback) &&
          callback.async &&
          callback.params.length === 0 &&
          callback.body.type === 'BlockStatement',
      );
      const declarations = callback.body.body.filter(
        (node) =>
          node.type === 'VariableDeclaration' &&
          node.kind === 'const' &&
          node.declarations.length === 1 &&
          node.declarations[0].init?.type === 'CallExpression' &&
          refs.get(node.declarations[0].init.callee) === helperVar,
      );
      check(declarations.length === 1);
      const declaration = declarations[0].declarations[0],
        input = declaration.init;
      check(declaration.id.type === 'Identifier' && input.arguments.length === 1 && literal(input.arguments[0]));
      const scope = scopes.acquire(callback),
        engine = scope?.variables.find((variable) => variable.identifiers.includes(declaration.id));
      check(engine && !engine.references.some((ref) => ref.isWrite() && !ref.init));
      check(
        engine.references
          .filter((ref) => !ref.init)
          .every((ref) => {
            const member = parents.get(ref.identifier),
              invoke = parents.get(member);
            return (
              member?.type === 'MemberExpression' &&
              !member.computed &&
              member.object === ref.identifier &&
              member.property.name === 'renderString' &&
              invoke?.type === 'CallExpression' &&
              invoke.callee === member &&
              invoke.arguments.length >= 1 &&
              invoke.arguments.every(literal)
            );
          }),
      );
      walk(callback.body, (node) => {
        if (node.type !== 'Identifier' || !refs.has(node)) return;
        const variable = refs.get(node);
        if (!variable) {
          check(node.name === 'undefined');
          return;
        }
        if (variable.scope === moduleScope) check(variable === helperVar || assertions.has(variable));
      });
      fixtures.push({
        baselineId: row.id,
        helperSha256: hash(helper),
        inputSha256: hash(input.arguments[0]),
        selectedBodySha256: hash(callback.body),
      });
    };
    for (const item of selected) certifySelected(item);

    return { ...empty(), fixtures, requiresAllRegistrations: true };
  } catch {
    return empty();
  }
}
