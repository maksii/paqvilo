import { hashAst as hash } from './parity-ast-utils.mjs';
// Source certificate for literal plain-renderer regions among deterministic date diagnostics.
// Native behavior, complete module guards and semantic review remain caller responsibilities.
import { createRequire } from 'node:module';
import { analyzeUnselectedFixtureSlice } from './parity-generated-fixtures.mjs';
const { analyze } = createRequire(import.meta.url)('eslint-scope');
const empty = () => ({
  recognizedIdentifiers: new Set(),
  recognizedBuiltinImports: new Set(),
  handledInputSources: new Set(),
  dependencies: [],
  fixtures: [],
  isolatedIdentifiers: new Set(),
});
const check = (v) => {
  if (!v) throw Error('unsupported-mixed-plain-renderer-slice');
};
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
/** `anchor` is an independent plain parent proving the original whole module's fixture isolation.
 * Each selected entry supplies `old` and exact `assertionHashes` of selected literal-input assertions.
 * Caller must bind the original full callbacks/module context and validate existing guards separately. */
export function analyzeMixedPlainRendererSlice(options) {
  try {
    const { ast, selected, anchor } = options;
    check(Array.isArray(selected) && selected.length && anchor?.callback && !selected.some((e) => e.old === anchor));
    const anchorProof = analyzeUnselectedFixtureSlice({ ...options, selected: [{ old: anchor }] });
    check(anchorProof.fixtures.length === 1 && anchorProof.isolatedIdentifiers.size > 0);
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }),
      refs = new Map();
    for (const scope of scopes.scopes) for (const ref of scope.references) refs.set(ref.identifier, ref.resolved);
    const active = new Set();
    const staticValue = (node) => {
      if (node?.type === 'Literal')
        return node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value);
      if (node?.type === 'ArrayExpression') return node.elements.every((x) => x && staticValue(x));
      if (node?.type === 'ObjectExpression')
        return node.properties.every(
          (p) =>
            p.type === 'Property' &&
            p.kind === 'init' &&
            !p.computed &&
            !p.method &&
            p.key.type === 'Identifier' &&
            staticValue(p.value),
        );
      if (node?.type === 'Identifier') {
        const variable = refs.get(node),
          def = variable?.defs?.[0];
        if (
          !variable ||
          variable.defs.length !== 1 ||
          def?.type !== 'Variable' ||
          def.parent?.kind !== 'const' ||
          variable.references.some((r) => r.isWrite() && !r.init) ||
          active.has(variable)
        )
          return false;
        active.add(variable);
        const result = staticValue(def.node.init);
        active.delete(variable);
        return result;
      }
      if (
        node?.type === 'NewExpression' &&
        node.callee?.name === 'Date' &&
        !refs.get(node.callee) &&
        node.arguments.length === 1
      ) {
        const c = node.arguments[0];
        return (
          c?.type === 'CallExpression' &&
          c.callee?.type === 'MemberExpression' &&
          !c.callee.computed &&
          c.callee.object?.name === 'Date' &&
          !refs.get(c.callee.object) &&
          c.callee.property?.name === 'UTC' &&
          c.arguments.length > 0 &&
          c.arguments.every((x) => x.type === 'Literal' && typeof x.value === 'number' && Number.isFinite(x.value))
        );
      }
      return false;
    };
    const unique = new Set(),
      fixtures = [];
    for (const entry of selected) {
      const row = entry?.old,
        callback = row?.callback,
        hashes = entry?.assertionHashes;
      check(
        row &&
          !row.parent &&
          !row.loops?.length &&
          callback?.type === 'ArrowFunctionExpression' &&
          callback.async &&
          !callback.generator &&
          (callback.params.length === 0 ||
            (callback.params.length === 1 && callback.params[0].type === 'Identifier')) &&
          callback.body.type === 'BlockStatement' &&
          row.node?.type === 'CallExpression' &&
          row.node.arguments.length === 2 &&
          row.node.arguments[1] === callback &&
          Array.isArray(hashes) &&
          hashes.length &&
          new Set(hashes).size === hashes.length &&
          !unique.has(row.id),
      );
      unique.add(row.id);
      const statements = callback.body.body,
        declaration = statements[0],
        item = declaration?.declarations?.[0];
      check(
        declaration?.type === 'VariableDeclaration' &&
          declaration.kind === 'const' &&
          declaration.declarations.length === 1 &&
          item.id.type === 'Identifier' &&
          item.init?.type === 'CallExpression' &&
          item.init.callee?.type === 'Identifier' &&
          item.init.arguments.length === 0,
      );
      const scope = scopes.acquire(callback),
        renderVar = scope?.variables.find((v) => v.identifiers.includes(item.id));
      check(renderVar && !renderVar.references.some((r) => r.isWrite() && !r.init));
      const selectedStatements = [],
        calls = new Set(),
        pageCalls = new Set();
      let pageVar = null,
        fixtureSeen = false;
      const lastSelected = Math.max(
        ...statements.map((s, i) => (s.type === 'ExpressionStatement' && hashes.includes(hash(s.expression)) ? i : -1)),
      );
      check(lastSelected > 0);
      for (let i = 1; i < statements.length; i++) {
        const statement = statements[i];
        if (statement.type === 'VariableDeclaration') {
          check(statement.kind === 'const' && statement.declarations.length === 1);
          const v = statement.declarations[0];
          if (v.id.type === 'ObjectPattern') {
            const call = v.init?.argument,
              parameter = callback.params[0],
              binding = refs.get(call?.callee),
              def = binding?.defs?.[0],
              props = v.id.properties;
            check(
              !fixtureSeen &&
                i > lastSelected &&
                parameter?.type === 'Identifier' &&
                v.init?.type === 'AwaitExpression' &&
                call?.type === 'CallExpression' &&
                call.callee?.type === 'Identifier' &&
                def?.type === 'FunctionName' &&
                binding.scope.type === 'module' &&
                !binding.references.some((r) => r.isWrite() && !r.init) &&
                call.arguments.length === 1 &&
                call.arguments[0].type === 'Identifier' &&
                refs.get(call.arguments[0]) === scope.variables.find((x) => x.identifiers.includes(parameter)) &&
                props.length === 1 &&
                props[0].type === 'Property' &&
                !props[0].computed &&
                props[0].key.name === 'render' &&
                props[0].value.type === 'Identifier',
            );
            pageVar = scope.variables.find((v) => v.identifiers.includes(props[0].value));
            check(pageVar && !pageVar.references.some((r) => r.isWrite() && !r.init));
            fixtureSeen = true;
          } else check(v.id.type === 'Identifier' && staticValue(v.init));
          continue;
        }
        const a = statement.type === 'ExpressionStatement' && statement.expression,
          obj = a?.callee?.object,
          def = refs.get(obj)?.defs?.[0];
        check(
          a?.type === 'CallExpression' &&
            a.callee?.type === 'MemberExpression' &&
            !a.callee.computed &&
            a.callee.property.name === 'equal' &&
            def?.parent?.source?.value === 'node:assert/strict' &&
            def.node.type === 'ImportDefaultSpecifier' &&
            a.arguments.length === 2 &&
            a.arguments[1]?.type === 'Literal',
        );
        const first = a.arguments[0],
          isPage =
            first?.type === 'MemberExpression' &&
            !first.computed &&
            first.property?.name === 'html' &&
            first.object?.type === 'AwaitExpression',
          awaited = isPage ? first.object : first,
          invoke = awaited?.argument;
        check(
          awaited?.type === 'AwaitExpression' &&
            invoke?.type === 'CallExpression' &&
            invoke.callee?.type === 'Identifier' &&
            invoke.arguments.length >= 1 &&
            invoke.arguments.length <= 2 &&
            invoke.arguments[0]?.type === 'Literal' &&
            typeof invoke.arguments[0].value === 'string' &&
            invoke.arguments.every(staticValue),
        );
        if (isPage) {
          check(fixtureSeen && i > lastSelected && refs.get(invoke.callee) === pageVar && !hashes.includes(hash(a)));
          pageCalls.add(invoke.callee);
        } else {
          check(!fixtureSeen && refs.get(invoke.callee) === renderVar);
          calls.add(invoke.callee);
        }
        if (hashes.includes(hash(a))) {
          check(
            !isPage &&
              invoke.arguments.every(
                (x) =>
                  x.type === 'Literal' ||
                  (x.type === 'ObjectExpression' &&
                    x.properties.every((p) => p.type === 'Property' && !p.computed && p.value.type === 'Literal')),
              ),
          );
          selectedStatements.push(statement);
        }
      }
      check(
        selectedStatements.length === hashes.length &&
          (!fixtureSeen ||
            (pageCalls.size > 0 &&
              statements.slice(1, lastSelected + 1).every((s) => selectedStatements.includes(s)))) &&
          renderVar.references.filter((r) => !r.init).every((r) => calls.has(r.identifier)) &&
          (!pageVar || pageVar.references.filter((r) => !r.init).every((r) => pageCalls.has(r.identifier))),
      );
      const saved = callback.body.body,
        savedParams = callback.params,
        bodySha256 = hash(callback.body),
        callbackSha256 = hash(callback);
      let proof;
      try {
        callback.body.body = [declaration, ...selectedStatements];
        callback.params = [];
        proof = analyzeUnselectedFixtureSlice({ ...options, selected: [{ old: row }] });
      } finally {
        callback.body.body = saved;
        callback.params = savedParams;
      }
      check(
        proof.fixtures.length === 1 &&
          sameSet(anchorProof.isolatedIdentifiers, proof.isolatedIdentifiers) &&
          JSON.stringify(anchorProof.dependencies) === JSON.stringify(proof.dependencies),
      );
      fixtures.push({
        ...proof.fixtures[0],
        selectedBodySha256: bodySha256,
        selectedCallbackSha256: callbackSha256,
        selectedAssertionHashes: hashes,
        surroundingStatementHashes: statements
          .filter((s) => s !== declaration && !selectedStatements.includes(s))
          .map(hash),
      });
    }
    return {
      ...anchorProof,
      fixtures,
      requiresAllRegistrations: true,
      requiresModuleIsolationProof: true,
      mixedRegionCertificate: true,
    };
  } catch {
    return empty();
  }
}
