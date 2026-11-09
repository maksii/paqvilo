// Source-bound, conservative certificates for unchanged memory-renderer callbacks.
// This certifies inputs and ordered caller operations, not native parity or renderer statelessness.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertPureFixtureBootstrap } from './parity-generated-fixtures.mjs';

const { analyze } = createRequire(import.meta.url)('eslint-scope');
const clean = (value) =>
  Array.isArray(value)
    ? value.map(clean)
    : !value || typeof value !== 'object'
      ? value
      : Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !['loc', 'range', 'start', 'end', 'raw'].includes(key))
            .map(([key, item]) => [key, clean(item)]),
        );
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(clean(value)))
    .digest('hex');
const fail = (reason) => {
  throw Object.assign(new Error(reason), { qualificationCode: reason });
};
const check = (ok, reason = 'unsupported-memory-context-slice') => {
  if (!ok) fail(reason);
};
function walk(node, visit, parent = null) {
  if (!node?.type) return;
  visit(node, parent);
  for (const value of Object.values(node))
    for (const item of Array.isArray(value) ? value : [value]) if (item?.type) walk(item, visit, node);
}
function literal(node) {
  if (node?.type === 'Literal')
    return (
      node.value === null ||
      ['string', 'boolean'].includes(typeof node.value) ||
      (typeof node.value === 'number' && Number.isFinite(node.value))
    );
  if (node?.type === 'ArrayExpression') return node.elements.every((item) => item && literal(item));
  if (node?.type === 'ObjectExpression')
    return (
      node.properties.every(
        (p) =>
          p.type === 'Property' &&
          p.kind === 'init' &&
          !p.computed &&
          !p.method &&
          !p.shorthand &&
          !['__proto__', 'prototype', 'constructor'].includes(p.key.name ?? p.key.value) &&
          literal(p.value),
      ) && new Set(node.properties.map((p) => p.key.name ?? p.key.value)).size === node.properties.length
    );
  return false;
}
function bootstrap(ast) {
  // The only excluded top-level statement is the qualifier's own imported binding guard.
  const allowed = new Set(
    ast.body
      .filter((x) => x.type === 'ImportDeclaration' && /(?:^|\/)scripts\/qualify-parity\.mjs$/u.test(x.source.value))
      .flatMap((x) =>
        x.specifiers
          .filter((s) => s.type === 'ImportSpecifier' && s.imported.name === 'assertParityBindings')
          .map((s) => s.local.name),
      ),
  );
  const filtered = {
    ...ast,
    body: ast.body.filter((x) => {
      const call = x.type === 'ExpressionStatement' && x.expression;
      if (
        !call ||
        call.type !== 'CallExpression' ||
        call.callee.type !== 'Identifier' ||
        !allowed.has(call.callee.name)
      )
        return true;
      const meta = call.arguments[0];
      check(
        call.arguments.length === 2 &&
          meta?.type === 'MemberExpression' &&
          !meta.computed &&
          meta.property.name === 'url' &&
          meta.object?.type === 'MetaProperty' &&
          meta.object.meta.name === 'import' &&
          meta.object.property.name === 'meta' &&
          literal(call.arguments[1]),
      );
      return false;
    }),
  };
  assertPureFixtureBootstrap({ ast: filtered });
}
function helper(ast, implementationSources) {
  const functions = ast.body.filter((x) => x.type === 'FunctionDeclaration');
  check(functions.length === 1);
  const fn = functions[0];
  check(
    fn.id?.name &&
      !fn.async &&
      !fn.generator &&
      fn.params.length === 2 &&
      fn.params[0].type === 'Identifier' &&
      fn.params[1].type === 'AssignmentPattern' &&
      fn.params[1].left.type === 'Identifier' &&
      fn.params[1].right.type === 'ObjectExpression' &&
      fn.params[1].right.properties.length === 0 &&
      fn.body.body.length === 1 &&
      fn.body.body[0].type === 'ReturnStatement',
  );
  const call = fn.body.body[0].argument,
    portal = call?.arguments?.[0];
  check(
    call?.type === 'CallExpression' &&
      call.callee.type === 'Identifier' &&
      call.arguments.length === 2 &&
      portal?.type === 'ObjectExpression' &&
      call.arguments[1].type === 'Identifier' &&
      call.arguments[1].name === fn.params[1].left.name,
  );
  const imports = ast.body.filter(
    (x) =>
      x.type === 'ImportDeclaration' &&
      implementationSources.includes(x.source.value) &&
      x.specifiers.some(
        (s) =>
          s.type === 'ImportSpecifier' &&
          s.imported.name === 'createPortalRenderer' &&
          s.local.name === call.callee.name,
      ),
  );
  check(imports.length === 1 && imports[0].specifiers.length === 1);
  let seenObserved = 0;
  const keys = [];
  for (const p of portal.properties) {
    check(
      p.type === 'Property' &&
        p.kind === 'init' &&
        !p.computed &&
        !p.method &&
        !['__proto__', 'prototype', 'constructor'].includes(p.key.name ?? p.key.value),
    );
    const key = p.key.name ?? p.key.value;
    keys.push(key);
    if (key === 'observed') {
      check(p.value.type === 'Identifier' && p.value.name === fn.params[0].name);
      seenObserved++;
    } else check(!p.shorthand && literal(p.value));
  }
  check(seenObserved === 1 && new Set(keys).size === keys.length);
  return fn;
}
/**
 * Certify one unchanged assertion's literal input and identical caller-state history.
 * Caller must independently enforce module/registration isolation and native evidence.
 * Changed parent bodies are rejected; no correction or profile migration is inferred.
 */
export function certifyMemoryContextSlice({
  baselineModel,
  currentModel,
  baselineId,
  assertionSha256,
  implementationSources = ['../lib/liquid.mjs'],
}) {
  check(
    baselineModel?.ast &&
      currentModel?.ast &&
      typeof baselineId === 'string' &&
      /^[a-f0-9]{64}$/u.test(assertionSha256 ?? ''),
  );
  try {
    bootstrap(baselineModel.ast);
    bootstrap(currentModel.ast);
  } catch {
    fail('unsupported-memory-context-bootstrap');
  }
  const oldHelper = helper(baselineModel.ast, implementationSources),
    newHelper = helper(currentModel.ast, implementationSources);
  check(digest(oldHelper) === digest(newHelper), 'memory-context-helper-drift');
  const old = baselineModel.registrations.find((r) => r.id === baselineId);
  check(
    old &&
      !old.parent &&
      old.loops.length === 0 &&
      old.callback?.async &&
      old.callback.params.length === 0 &&
      old.callback.body.type === 'BlockStatement',
  );
  const matches = currentModel.registrations.filter((r) => r.titleExpressionSha256 === old.titleExpressionSha256);
  check(matches.length === 1);
  const current = matches[0];
  check(digest(old.callback.body) === digest(current.callback.body), 'memory-context-parent-body-drift');
  const oldAssertions = old.assertions.filter((a) => a.sha256 === assertionSha256),
    newAssertions = current.assertions.filter((a) => a.sha256 === assertionSha256);
  check(oldAssertions.length === 1 && newAssertions.length === 1, 'memory-context-assertion-mismatch');
  const assertion = oldAssertions[0].node,
    awaited = assertion.arguments?.[0],
    call = awaited?.argument;
  check(
    awaited?.type === 'AwaitExpression' &&
      call?.type === 'CallExpression' &&
      !call.optional &&
      call.arguments.length === 1 &&
      call.callee?.type === 'MemberExpression' &&
      !call.callee.computed &&
      call.callee.property.name === 'renderString',
  );
  const parents = new Map(),
    refs = new Map(),
    manager = analyze(baselineModel.ast, { ecmaVersion: 2022, sourceType: 'module' });
  walk(baselineModel.ast, (node, parent) => parents.set(node, parent));
  for (const scope of manager.scopes) for (const ref of scope.references) refs.set(ref.identifier, ref.resolved);
  const moduleScope = manager.scopes.find((s) => s.type === 'module'),
    helperVar = moduleScope?.variables.find((v) => v.identifiers.includes(oldHelper.id));
  check(helperVar);
  const implementation = refs.get(oldHelper.body.body[0].argument.callee);
  check(
    implementation?.scope === moduleScope &&
      implementation.defs.length === 1 &&
      implementation.defs[0].type === 'ImportBinding' &&
      implementationSources.includes(implementation.defs[0].parent.source.value),
  );
  function construction(node) {
    check(
      node?.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        refs.get(node.callee) === helperVar &&
        node.arguments.length <= 2 &&
        node.arguments.every(literal),
    );
    return node;
  }
  function localConstant(node) {
    check(node?.type === 'Identifier');
    const variable = refs.get(node),
      def = variable?.defs?.[0];
    check(
      variable &&
        variable.scope.block === old.callback &&
        variable.defs.length === 1 &&
        def.type === 'Variable' &&
        def.parent.kind === 'const' &&
        !variable.references.some((r) => r.isWrite() && !r.init),
    );
    return { variable, init: def.node.init };
  }
  function staticSource(node) {
    const value = node?.type === 'Identifier' ? localConstant(node).init : node;
    check(value?.type === 'Literal' && typeof value.value === 'string');
    return value.value;
  }
  const receiver = call.callee.object;
  let input,
    engine = null;
  if (receiver.type === 'CallExpression') input = construction(receiver);
  else {
    check(receiver.type === 'Identifier');
    engine = refs.get(receiver);
    check(
      engine &&
        engine.scope.block === old.callback &&
        engine.defs.length === 1 &&
        engine.defs[0].type === 'Variable' &&
        engine.defs[0].parent.kind === 'const' &&
        !engine.references.some((r) => r.isWrite() && !r.init),
    );
    input = construction(engine.defs[0].node.init);
    for (const ref of engine.references.filter((r) => !r.init)) {
      const member = parents.get(ref.identifier),
        invoke = parents.get(member);
      check(
        member?.type === 'MemberExpression' &&
          !member.computed &&
          member.object === ref.identifier &&
          ['renderString', 'contextForPage'].includes(member.property.name) &&
          invoke?.type === 'CallExpression' &&
          invoke.callee === member &&
          !invoke.optional,
      );
      if (member.property.name === 'contextForPage') {
        check(invoke.arguments.length > 0 && invoke.arguments.every(literal));
      } else {
        check(parents.get(invoke)?.type === 'AwaitExpression');
        check(invoke.arguments.length >= 1 && invoke.arguments.length <= 2);
        staticSource(invoke.arguments[0]);
        if (invoke.arguments.length === 2 && !literal(invoke.arguments[1])) {
          const { variable, init } = localConstant(invoke.arguments[1]);
          check(
            init?.type === 'CallExpression' &&
              init.callee?.type === 'MemberExpression' &&
              !init.callee.computed &&
              init.callee.property.name === 'contextForPage' &&
              init.callee.object.type === 'Identifier' &&
              refs.get(init.callee.object) === engine &&
              init.arguments.length > 0 &&
              init.arguments.every(literal),
          );
          for (const use of variable.references.filter((r) => !r.init)) {
            const parent = parents.get(use.identifier),
              memberUse = parent?.callee;
            check(
              parent?.type === 'CallExpression' &&
                parent.arguments.includes(use.identifier) &&
                memberUse?.type === 'MemberExpression' &&
                !memberUse.computed &&
                memberUse.property.name === 'renderString' &&
                memberUse.object.type === 'Identifier' &&
                refs.get(memberUse.object) === engine,
            );
          }
        }
      }
    }
  }
  const sourceValue = staticSource(call.arguments[0]);
  const statement = old.callback.body.body.find(
    (s) => s.range[0] <= assertion.range[0] && s.range[1] >= assertion.range[1],
  );
  check(statement && statement.type === 'ExpressionStatement' && statement.expression === assertion);
  const prefix = old.callback.body.body.slice(0, old.callback.body.body.indexOf(statement));
  return Object.freeze({
    kind: 'unchanged-memory-context-input',
    baselineId,
    assertionSha256,
    baselineSourceSha256: baselineModel.sourceSha256,
    currentSourceSha256: currentModel.sourceSha256,
    helperSha256: digest(oldHelper),
    constructionSha256: digest(input),
    callbackSha256: digest(old.callback.body),
    orderedPrefixSha256: digest(prefix),
    operationSha256: digest(awaited),
    sourceSha256: createHash('sha256').update(sourceValue).digest('hex'),
    context: 'omitted',
    receiver: engine ? 'retained-engine' : 'fresh-inline',
    moduleIsolationRequired: true,
    rendererStateProof: 'identical ordered caller history; renderer implementation state is not assumed absent',
    nativeParityProven: false,
  });
}
