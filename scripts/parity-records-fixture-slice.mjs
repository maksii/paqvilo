import { hashAst as hash } from './parity-ast-utils.mjs';
// Infer the literal inputs and unreachable random import of a fresh-store fixture.
// This is a source/input certificate, not evidence of native behaviour.
import { createRequire } from 'node:module';
const { analyze } = createRequire(import.meta.url)('eslint-scope');
const check = (v) => {
  if (!v)
    throw Object.assign(new Error('unsupported-records-fixture-slice'), {
      qualificationCode: 'unsupported-records-fixture-slice',
    });
};
function walk(n, fn, parent = null) {
  if (!n?.type) return;
  fn(n, parent);
  for (const v of Object.values(n)) for (const c of Array.isArray(v) ? v : [v]) if (c?.type) walk(c, fn, n);
}
function consumesPromise(wrapper) {
  if (
    !wrapper?.async ||
    wrapper.type !== 'FunctionDeclaration' ||
    wrapper.params.length !== 1 ||
    wrapper.params[0].type !== 'Identifier' ||
    wrapper.body.body.length !== 2
  )
    return false;
  const attempt = wrapper.body.body[0],
    fail = wrapper.body.body[1];
  if (
    attempt.type !== 'TryStatement' ||
    attempt.finalizer ||
    attempt.block.body.length !== 1 ||
    attempt.block.body[0].type !== 'ExpressionStatement' ||
    attempt.block.body[0].expression?.type !== 'AwaitExpression' ||
    attempt.block.body[0].expression.argument?.name !== wrapper.params[0].name
  )
    return false;
  if (
    !attempt.handler ||
    attempt.handler.param?.type !== 'Identifier' ||
    attempt.handler.body.body.length !== 1 ||
    attempt.handler.body.body[0].type !== 'ReturnStatement' ||
    attempt.handler.body.body[0].argument?.name !== attempt.handler.param.name
  )
    return false;
  return (
    fail.type === 'ThrowStatement' &&
    fail.argument?.type === 'NewExpression' &&
    fail.argument.callee?.name === 'Error' &&
    fail.argument.arguments.length === 1 &&
    fail.argument.arguments[0].type === 'Literal' &&
    typeof fail.argument.arguments[0].value === 'string'
  );
}
function model(ast) {
  const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }),
    moduleScope = scopes.scopes.find((s) => s.type === 'module'),
    refs = scopes.scopes.flatMap((s) => s.references),
    parents = new Map();
  walk(ast, (n, p) => parents.set(n, p));
  return { ast, scopes, moduleScope, refs, parents };
}
function declaration(ast, name, kind) {
  const nodes = ast.body.filter(
    (n) =>
      n.type === 'VariableDeclaration' &&
      n.kind === kind &&
      n.declarations.length === 1 &&
      n.declarations[0].id?.name === name,
  );
  check(nodes.length === 1);
  return nodes[0];
}
function functionByName(ast, name) {
  const nodes = ast.body.filter((n) => n.type === 'FunctionDeclaration' && n.id?.name === name);
  check(nodes.length === 1);
  return nodes[0];
}
// Only the selected test's direct response can feed this pure key projection.
function responseKeyProjection(m, object, initial) {
  const keysMember = m.parents.get(object),
    keysCall = m.parents.get(keysMember),
    filterMember = m.parents.get(keysCall),
    filterCall = m.parents.get(filterMember),
    sortMember = m.parents.get(filterCall),
    sortCall = m.parents.get(sortMember),
    response = keysCall?.arguments?.[0],
    predicate = filterCall?.arguments?.[0];
  if (
    keysMember?.type !== 'MemberExpression' ||
    keysMember.object !== object ||
    keysMember.computed ||
    keysMember.property.name !== 'keys' ||
    keysCall?.type !== 'CallExpression' ||
    keysCall.callee !== keysMember ||
    keysCall.arguments.length !== 1 ||
    response?.type !== 'MemberExpression' ||
    response.computed ||
    response.property.name !== 'body' ||
    response.object?.type !== 'Identifier' ||
    filterMember?.type !== 'MemberExpression' ||
    filterMember.object !== keysCall ||
    filterMember.computed ||
    filterMember.property.name !== 'filter' ||
    filterCall?.type !== 'CallExpression' ||
    filterCall.callee !== filterMember ||
    filterCall.arguments.length !== 1 ||
    predicate?.type !== 'ArrowFunctionExpression' ||
    predicate.async ||
    predicate.params.length !== 1 ||
    predicate.params[0]?.type !== 'Identifier' ||
    predicate.body?.type !== 'UnaryExpression' ||
    predicate.body.operator !== '!' ||
    sortMember?.type !== 'MemberExpression' ||
    sortMember.object !== filterCall ||
    sortMember.computed ||
    sortMember.property.name !== 'sort' ||
    sortCall?.type !== 'CallExpression' ||
    sortCall.callee !== sortMember ||
    sortCall.arguments.length !== 0
  )
    return false;
  const starts = predicate.body.argument,
    param = predicate.params[0];
  if (
    starts?.type !== 'CallExpression' ||
    starts.arguments.length !== 1 ||
    starts.arguments[0]?.type !== 'Literal' ||
    starts.arguments[0].value !== '@' ||
    starts.callee?.type !== 'MemberExpression' ||
    starts.callee.computed ||
    starts.callee.property.name !== 'startsWith' ||
    starts.callee.object?.type !== 'Identifier'
  )
    return false;
  const paramRef = m.refs.find((r) => r.identifier === starts.callee.object),
    resultRef = m.refs.find((r) => r.identifier === response.object),
    result = resultRef?.resolved,
    def = result?.defs[0],
    awaitCall = def?.node?.init,
    send = awaitCall?.argument,
    runtimeRef = m.refs.find((r) => r.identifier === send?.callee?.object);
  return (
    paramRef?.resolved?.defs.length === 1 &&
    paramRef.resolved.defs[0].type === 'Parameter' &&
    paramRef.resolved.defs[0].node === predicate &&
    param.name === starts.callee.object.name &&
    result?.defs.length === 1 &&
    def?.type === 'Variable' &&
    def.parent.kind === 'const' &&
    def.node.id.type === 'Identifier' &&
    !result.references.some((r) => r.isWrite() && !r.init) &&
    awaitCall?.type === 'AwaitExpression' &&
    send?.type === 'CallExpression' &&
    send.callee?.type === 'MemberExpression' &&
    !send.callee.computed &&
    send.callee.property.name === 'send' &&
    send.callee.object?.type === 'Identifier' &&
    runtimeRef?.resolved?.defs.length === 1 &&
    runtimeRef.resolved.defs[0].node === initial.declarations[0]
  );
}
function literal(m, node, seen = new Set(), allowObjectReferences = false) {
  if (node?.type === 'Literal') {
    check(node.value === null || ['string', 'boolean', 'number'].includes(typeof node.value));
    if (typeof node.value === 'number') check(Number.isFinite(node.value));
    return node.value;
  }
  if (
    node?.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument?.type === 'Literal' &&
    typeof node.argument.value === 'number'
  ) {
    const value = -node.argument.value;
    check(!Object.is(value, -0));
    return value;
  }
  if (node?.type === 'ArrayExpression') {
    check(node.elements.every((item) => item !== null));
    return node.elements.map((item) => {
      check(item);
      return literal(m, item, seen, allowObjectReferences);
    });
  }
  if (node?.type === 'ObjectExpression') {
    const pairs = node.properties.map((p) => {
      check(p.type === 'Property' && p.kind === 'init' && !p.computed && !p.method && !p.shorthand);
      const key = p.key.name ?? p.key.value;
      check(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key));
      return [key, literal(m, p.value, seen, allowObjectReferences)];
    });
    check(new Set(pairs.map((x) => x[0])).size === pairs.length);
    return Object.fromEntries(pairs);
  }
  if (node?.type === 'Identifier') {
    const ref = m.refs.find((r) => r.identifier === node),
      v = ref?.resolved,
      def = v?.defs[0];
    check(
      v?.scope === m.moduleScope &&
        v.defs.length === 1 &&
        def?.type === 'Variable' &&
        def.parent?.kind === 'const' &&
        def.node.id?.type === 'Identifier' &&
        def.node.id.name === node.name &&
        !v.references.some((r) => r.isWrite() && !r.init) &&
        !seen.has(v),
    );
    const next = new Set(seen);
    next.add(v);
    const value = literal(m, def.node.init, next, allowObjectReferences);
    check(allowObjectReferences || value === null || typeof value !== 'object');
    return value;
  }
  check(false);
}
/** Infer only one selected test's source-bound module closure; caller must pin all registrations and module context. */
export function analyzeRecordsFixtureSlice({ baselineAst, currentAst, selected, implementationSources = [] }) {
  check(Array.isArray(selected) && selected.length === 1 && selected[0].old && selected[0].current);
  const old = model(baselineAst),
    current = model(currentAst),
    row = selected[0].old;
  check(
    row.callback?.type === 'ArrowFunctionExpression' &&
      row.callback.async &&
      row.callback.params.length === 0 &&
      row.callback.body.type === 'BlockStatement',
  );
  const initial = row.callback.body.body[0];
  check(
    initial?.type === 'VariableDeclaration' &&
      initial.kind === 'const' &&
      initial.declarations.length === 1 &&
      initial.declarations[0].id.type === 'Identifier' &&
      initial.declarations[0].init?.type === 'AwaitExpression' &&
      initial.declarations[0].init.argument?.type === 'CallExpression' &&
      initial.declarations[0].init.argument.callee?.type === 'Identifier' &&
      initial.declarations[0].init.argument.arguments.length === 0,
  );
  const setupCall = initial.declarations[0].init.argument;
  const setupRef = old.refs.find((r) => r.identifier === setupCall.callee);
  check(
    setupRef?.resolved?.scope === old.moduleScope &&
      setupRef.resolved.defs.length === 1 &&
      setupRef.resolved.defs[0].type === 'FunctionName',
  );
  const queue = [row.callback],
    visited = new Set(),
    functions = new Map(),
    bindings = new Map();
  const checkUnresolvedReference = (ref) => {
    const parent = old.parents.get(ref.identifier),
      grand = old.parents.get(parent);
    if (ref.identifier.name === 'undefined') return;
    if (ref.identifier.name === 'URL' || ref.identifier.name === 'Error') {
      check(parent?.type === 'NewExpression' && parent.callee === ref.identifier);
      return;
    }
    if (ref.identifier.name === 'Object') {
      check(
        responseKeyProjection(old, ref.identifier, initial) ||
          (parent?.type === 'MemberExpression' &&
            parent.object === ref.identifier &&
            !parent.computed &&
            ['entries', 'fromEntries'].includes(parent.property.name) &&
            grand?.type === 'CallExpression' &&
            grand.callee === parent),
      );
      return;
    }
    check(false);
  };
  const collectFixtureDependencies = () => {
    while (queue.length) {
      const node = queue.shift();
      if (visited.has(node)) continue;
      visited.add(node);
      const within = new Set();
      walk(node, (n) => within.add(n));
      const collectReference = (ref) => {
        const v = ref.resolved;
        if (!v) {
          checkUnresolvedReference(ref);
          return;
        }
        if (v.scope !== old.moduleScope) return;
        check(v.defs.length === 1);
        const def = v.defs[0];
        if (def.type === 'ImportBinding') {
          const source = def.parent.source.value;
          check(implementationSources.includes(source) || ['node:assert', 'node:assert/strict'].includes(source));
          return;
        }
        if (def.type === 'FunctionName') {
          const fn = def.node;
          check((fn.type === 'FunctionDeclaration' && !functions.has(v.name)) || functions.get(v.name) === fn);
          if (!functions.has(v.name)) {
            functions.set(v.name, fn);
            queue.push(fn);
          }
          return;
        }
        check(
          def.type === 'Variable' &&
            def.parent?.kind === 'const' &&
            def.node.id?.type === 'Identifier' &&
            def.node.id.name === v.name &&
            !v.references.some((r) => r.isWrite() && !r.init),
        );
        if (!bindings.has(v.name)) {
          bindings.set(v.name, { node: def.parent, expected: literal(old, def.node.init) });
          queue.push(def.node.init);
        }
      };
      for (const ref of old.refs.filter((r) => within.has(r.identifier))) collectReference(ref);
    }
  };
  collectFixtureDependencies();
  check(functions.has(setupCall.callee.name) && functions.size > 0 && bindings.size > 0);
  // The selected no-argument setup must allocate the store from a fresh authored state.
  const verifySetupFixture = () => {
    const setup = functions.get(setupCall.callee.name),
      setupBody = setup.body.body;
    check(
      setup.async &&
        !setup.generator &&
        (setup.params.length === 0 ||
          (setup.params.length === 1 &&
            setup.params[0].type === 'AssignmentPattern' &&
            setup.params[0].left.type === 'Identifier' &&
            setup.params[0].right.type === 'ObjectExpression' &&
            setup.params[0].right.properties.length === 0)),
    );
    const storeStatement = setupBody[0],
      returned = setupBody.at(-1);
    check(
      storeStatement?.type === 'VariableDeclaration' &&
        storeStatement.kind === 'const' &&
        storeStatement.declarations.length === 1 &&
        storeStatement.declarations[0].id.type === 'Identifier',
    );
    const storeName = storeStatement.declarations[0].id.name,
      instance = storeStatement.declarations[0].init;
    check(
      instance?.type === 'NewExpression' &&
        instance.callee?.type === 'Identifier' &&
        instance.arguments.length === 1 &&
        instance.arguments[0].type === 'ObjectExpression' &&
        instance.arguments[0].properties.length === 1,
    );
    const stateProperty = instance.arguments[0].properties[0];
    check(
      stateProperty.type === 'Property' &&
        !stateProperty.computed &&
        !stateProperty.method &&
        (stateProperty.key.name ?? stateProperty.key.value) === 'state' &&
        stateProperty.value?.type === 'CallExpression' &&
        stateProperty.value.callee?.type === 'Identifier' &&
        stateProperty.value.arguments.length === 0,
    );
    const storeRef = old.refs.find((ref) => ref.identifier === instance.callee),
      stateRef = old.refs.find((ref) => ref.identifier === stateProperty.value.callee);
    check(
      storeRef?.resolved?.defs.length === 1 &&
        storeRef.resolved.defs[0].type === 'ImportBinding' &&
        implementationSources.includes(storeRef.resolved.defs[0].parent.source.value),
    );
    check(
      stateRef?.resolved?.scope === old.moduleScope &&
        stateRef.resolved.defs.length === 1 &&
        stateRef.resolved.defs[0].type === 'FunctionName' &&
        functions.get(stateRef.identifier.name) === stateRef.resolved.defs[0].node,
    );
    check(
      returned?.type === 'ReturnStatement' &&
        returned.argument?.type === 'ObjectExpression' &&
        returned.argument.properties.filter(
          (property) =>
            property.type === 'Property' &&
            !property.computed &&
            (property.key.name ?? property.key.value) === storeName &&
            property.value?.type === 'Identifier' &&
            property.value.name === storeName,
        ).length === 1,
    );
    check(
      returned.argument.properties.every(
        (property) =>
          property.type === 'Property' && property.kind === 'init' && !property.computed && !property.method,
      ) &&
        new Set(returned.argument.properties.map((property) => property.key.name ?? property.key.value)).size ===
          returned.argument.properties.length,
    );
    return stateRef;
  };
  const stateRef = verifySetupFixture();
  const stateFactory = stateRef.resolved.defs[0].node,
    stateBody = stateFactory.body.body;
  check(!stateFactory.async && !stateFactory.generator && stateFactory.params.length === 0 && stateBody.length >= 2);
  const start = stateBody[0],
    finish = stateBody.at(-1);
  check(
    start.type === 'VariableDeclaration' &&
      start.kind === 'const' &&
      start.declarations.length === 1 &&
      start.declarations[0].id.type === 'Identifier',
  );
  const stateName = start.declarations[0].id.name,
    seed = start.declarations[0].init;
  check(
    seed?.type === 'CallExpression' &&
      seed.callee?.type === 'Identifier' &&
      seed.arguments.length === 0 &&
      finish?.type === 'ReturnStatement' &&
      finish.argument?.type === 'Identifier' &&
      finish.argument.name === stateName,
  );
  const seedRef = old.refs.find((ref) => ref.identifier === seed.callee),
    stateVar = old.scopes.scopes
      .flatMap((scope) => scope.variables)
      .find((variable) => variable.identifiers.includes(start.declarations[0].id));
  check(
    seedRef?.resolved?.defs.length === 1 &&
      seedRef.resolved.defs[0].type === 'ImportBinding' &&
      implementationSources.includes(seedRef.resolved.defs[0].parent.source.value) &&
      stateVar,
  );
  const target = (node, loopName = null) => {
    let cursor = node,
      depth = 0;
    while (cursor?.type === 'MemberExpression') {
      if (cursor.computed)
        check(loopName && cursor.property?.type === 'Identifier' && cursor.property.name === loopName);
      else
        check(
          cursor.property?.type === 'Identifier' &&
            !['prototype', 'constructor', '__proto__'].includes(cursor.property.name),
        );
      cursor = cursor.object;
      depth++;
    }
    const ref = old.refs.find((item) => item.identifier === cursor);
    check(depth > 0 && cursor?.type === 'Identifier' && cursor.name === stateName && ref?.resolved === stateVar);
  };
  const assignment = (statement, loopName = null) => {
    const expression = statement?.type === 'ExpressionStatement' && statement.expression;
    check(expression?.type === 'AssignmentExpression' && expression.operator === '=');
    target(expression.left, loopName);
    literal(old, expression.right, new Set(), true);
  };
  const verifyStateStatements = () => {
    for (const statement of stateBody.slice(1, -1)) {
      if (statement.type !== 'ForOfStatement') {
        assignment(statement);
        continue;
      }
      const left = statement.left,
        values = statement.right;
      check(
        !statement.await &&
          left.type === 'VariableDeclaration' &&
          left.kind === 'const' &&
          left.declarations.length === 1 &&
          left.declarations[0].id.type === 'Identifier' &&
          !left.declarations[0].init &&
          values.type === 'ArrayExpression' &&
          values.elements.length > 0 &&
          values.elements.every((item) => item?.type === 'Literal' && typeof item.value === 'string'),
      );
      assignment(statement.body, left.declarations[0].id.name);
    }
  };
  verifyStateStatements();
  const stateReturns = stateVar.references.filter(
    (ref) => ref.isRead() && old.parents.get(ref.identifier)?.type === 'ReturnStatement',
  );
  check(stateReturns.length === 1 && stateReturns[0].identifier === finish.argument);

  function uuidEvidence(side, selectedRow) {
    const ast = side.ast;
    const imports = ast.body.filter(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.source.value === 'node:crypto' &&
        node.specifiers.some(
          (specifier) => specifier.type === 'ImportSpecifier' && specifier.imported.name === 'randomUUID',
        ),
    );
    check(
      imports.length === 1 &&
        imports[0].specifiers.length === 1 &&
        imports[0].specifiers[0].local.type === 'Identifier',
    );
    const uuidName = imports[0].specifiers[0].local.name,
      uuidVariable = side.moduleScope.variables.find((variable) => variable.name === uuidName);
    check(uuidVariable?.defs.length === 1 && uuidVariable.defs[0].parent === imports[0]);
    const testImports = ast.body.filter(
      (node) => node.type === 'ImportDeclaration' && node.source.value === 'node:test',
    );
    check(
      testImports.length === 1 &&
        testImports[0].specifiers.length === 1 &&
        testImports[0].specifiers[0].type === 'ImportDefaultSpecifier',
    );
    const testName = testImports[0].specifiers[0].local.name,
      testVariable = side.moduleScope.variables.find((variable) => variable.name === testName);
    check(testVariable?.defs.length === 1);
    const registrations = ast.body
      .filter(
        (node) =>
          node.type === 'ExpressionStatement' &&
          node.expression?.type === 'CallExpression' &&
          node.expression.callee?.name === testName,
      )
      .map((node) => node.expression);
    check(
      registrations.includes(selectedRow.node) &&
        registrations.every(
          (node) =>
            node.arguments.length === 2 &&
            ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.arguments[1]?.type),
        ) &&
        testVariable.references.every((ref) => registrations.some((node) => node.callee === ref.identifier)),
    );
    const scheduling = {
      awaitedSubtests: [],
      awaitedPromiseResolutions: [],
      awaitedLocalCalls: [],
      awaitedSendCalls: [],
      promiseWrappers: [],
    };
    const wrapperHashes = new Set();
    const forbiddenIdentifiers = new Set([
      'setTimeout',
      'setInterval',
      'setImmediate',
      'queueMicrotask',
      'nextTick',
      'globalThis',
      'global',
      'process',
      'Worker',
      'MessageChannel',
      'scheduler',
      'eval',
      'Function',
      'AsyncFunction',
      'AsyncGeneratorFunction',
      'then',
      'catch',
      'finally',
    ]);
    const verifySchedulingReferences = () => {
      for (const ref of side.refs) {
        check(!forbiddenIdentifiers.has(ref.identifier.name));
        if (ref.identifier.name === 'Promise') {
          const member = side.parents.get(ref.identifier),
            call = side.parents.get(member),
            awaited = side.parents.get(call);
          check(
            !ref.resolved &&
              member?.type === 'MemberExpression' &&
              member.object === ref.identifier &&
              !member.computed &&
              member.property.name === 'resolve' &&
              call?.type === 'CallExpression' &&
              call.callee === member &&
              call.arguments.length === 0 &&
              awaited?.type === 'AwaitExpression' &&
              awaited.argument === call,
          );
          scheduling.awaitedPromiseResolutions.push(hash(awaited));
        }
      }
    };
    verifySchedulingReferences();
    const verifyAsyncVariable = (variable) => {
      const definition = variable.defs[0];
      let fn = null;
      if (definition?.type === 'FunctionName') fn = definition.node;
      else if (definition?.type === 'Variable') fn = definition.node.init;
      if (!fn?.async || !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(fn.type))
        return;
      for (const ref of variable.references.filter((item) => item.isRead())) {
        const parent = side.parents.get(ref.identifier),
          owner = side.parents.get(parent);
        if (parent?.type === 'CallExpression' && parent.callee === ref.identifier) {
          check(owner?.type === 'AwaitExpression' && owner.argument === parent);
          scheduling.awaitedLocalCalls.push(hash(parent));
          continue;
        }
        // The fixture exposes its fresh local send function as a return property.
        check(
          variable.name === 'send' &&
            parent?.type === 'Property' &&
            parent.value === ref.identifier &&
            parent.shorthand &&
            owner?.type === 'ObjectExpression' &&
            side.parents.get(owner)?.type === 'ReturnStatement' &&
            side.parents.get(side.parents.get(owner)) === functionByName(side.ast, setupCall.callee.name).body &&
            side.parents.get(definition.parent) === functionByName(side.ast, setupCall.callee.name).body,
        );
      }
    };
    const verifyAsyncFunctions = () => {
      for (const scope of side.scopes.scopes) for (const variable of scope.variables) verifyAsyncVariable(variable);
    };
    verifyAsyncFunctions();
    const checkSend = (node, parent) => {
      check(parent?.type === 'CallExpression' && parent.callee === node);
      const owner = side.parents.get(parent);
      if (owner?.type !== 'AwaitExpression') {
        check(
          owner?.type === 'CallExpression' &&
            owner.arguments.length === 1 &&
            owner.arguments[0] === parent &&
            owner.callee?.type === 'Identifier' &&
            side.parents.get(owner)?.type === 'AwaitExpression',
        );
        const ref = side.refs.find((item) => item.identifier === owner.callee),
          definition = ref?.resolved?.defs[0];
        check(
          ref?.resolved?.scope === side.moduleScope &&
            ref.resolved.defs.length === 1 &&
            definition?.type === 'FunctionName' &&
            consumesPromise(definition.node),
        );
        wrapperHashes.add(hash(definition.node));
      }
      scheduling.awaitedSendCalls.push(hash(parent));
    };
    const checkSubtest = (node, parent) => {
      check(
        parent?.type === 'CallExpression' &&
          parent.callee === node &&
          side.parents.get(parent)?.type === 'AwaitExpression' &&
          parent.arguments.length === 2 &&
          parent.arguments[0]?.type === 'Literal' &&
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(parent.arguments[1]?.type) &&
          node.object?.type === 'Identifier',
      );
      let ancestor = parent,
        owner = null;
      while (ancestor) {
        if (registrations.includes(ancestor)) {
          owner = ancestor;
          break;
        }
        ancestor = side.parents.get(ancestor);
      }
      const context = side.refs.find((ref) => ref.identifier === node.object);
      check(
        owner &&
          context?.resolved?.defs.length === 1 &&
          context.resolved.defs[0].type === 'Parameter' &&
          context.resolved.defs[0].node === owner.arguments[1],
      );
      scheduling.awaitedSubtests.push(hash(parent));
    };
    const checkObjectPattern = (node) => {
      if (node.type === 'Property' && side.parents.get(node)?.type === 'ObjectPattern')
        check(
          !node.computed &&
            ![
              'then',
              'catch',
              'finally',
              'setTimeout',
              'setInterval',
              'setImmediate',
              'queueMicrotask',
              'nextTick',
            ].includes(node.key.name ?? node.key.value),
        );
    };
    walk(ast, (node, parent) => {
      if (node.type === 'ImportDeclaration')
        check(
          ![
            'node:timers',
            'timers',
            'node:timers/promises',
            'timers/promises',
            'node:worker_threads',
            'worker_threads',
            'node:child_process',
            'child_process',
          ].includes(node.source.value),
        );
      check(node.type !== 'ImportExpression');
      checkObjectPattern(node);
      if (node.type !== 'MemberExpression') return;
      if (node.computed && node.property?.type !== 'Literal')
        check(
          parent?.type !== 'VariableDeclarator' &&
            parent?.type !== 'ReturnStatement' &&
            !(parent?.type === 'AssignmentExpression' && parent.right === node) &&
            !(parent?.type === 'CallExpression' && parent.callee === node),
        );
      let property;
      if (node.computed) property = node.property?.type === 'Literal' ? node.property.value : null;
      else property = node.property.name;
      check(
        ![
          'setTimeout',
          'setInterval',
          'setImmediate',
          'queueMicrotask',
          'nextTick',
          'then',
          'catch',
          'finally',
        ].includes(property),
      );
      if (property === 'send') checkSend(node, parent);
      else if (property === 'test') checkSubtest(node, parent);
    });
    const sites = [];
    const verifyUuidSites = () => {
      for (const ref of uuidVariable.references) {
        const call = side.parents.get(ref.identifier);
        check(call?.type === 'CallExpression' && call.callee === ref.identifier && call.arguments.length === 0);
        let ancestor = call,
          owner = null;
        while (ancestor) {
          if (registrations.includes(ancestor)) {
            owner = ancestor;
            break;
          }
          ancestor = side.parents.get(ancestor);
        }
        check(owner && owner !== selectedRow.node);
        let inCallbackBody = false;
        walk(owner.arguments[1].body, (node) => {
          if (node === call) inCallbackBody = true;
        });
        check(inCallbackBody);
        sites.push({ registrationTitleAstSha256: hash(owner.arguments[0]), callAstSha256: hash(call) });
      }
    };
    verifyUuidSites();
    check(sites.length > 0);
    scheduling.promiseWrappers = [...wrapperHashes].sort((a, b) => Number(a > b) - Number(a < b));
    return { importNode: imports[0], sites, scheduling };
  }
  const oldUuid = uuidEvidence(old, row),
    currentUuid = uuidEvidence(current, selected[0].current);
  check(
    hash(oldUuid.importNode) === hash(currentUuid.importNode) &&
      JSON.stringify(oldUuid.sites) === JSON.stringify(currentUuid.sites),
  );
  const closure = [...functions]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, node]) => {
      const next = functionByName(currentAst, name);
      check(hash(node) === hash(next));
      return { name, astSha256: hash(node) };
    });
  const inputs = [...bindings]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, item]) => {
      const next = declaration(currentAst, name, 'const');
      check(hash(item.node) === hash(next));
      return { name, expected: item.expected, declarationAstSha256: hash(item.node) };
    });
  const currentBody = selected[0].current.callback?.body;
  check(currentBody?.type === 'BlockStatement');
  const currentStatements = currentBody.body.filter((statement) => hash(statement) === hash(initial));
  check(currentStatements.length === 1);
  const descriptor = {
    version: 1,
    setupBinding: setupCall.callee.name,
    closure,
    inputs,
    uuidImportAstSha256: hash(oldUuid.importNode),
    uuidSites: oldUuid.sites,
    scheduling: { baseline: oldUuid.scheduling, current: currentUuid.scheduling },
    requiresAllRegistrations: true,
    requiresFullModuleContext: true,
  };
  const empty = (importNode) => ({
    recognizedIdentifiers: new Set(),
    isolatedIdentifiers: new Set(),
    recognizedBuiltinImports: new Set([importNode]),
    recognizedExternalInputs: new Set(),
    handledInputSources: new Set(),
    dependencies: [],
    fixtures: [descriptor],
    requiresAllRegistrations: true,
  });
  return {
    old: empty(oldUuid.importNode),
    current: empty(currentUuid.importNode),
    descriptor,
    guardInsertion: {
      baselineStatement: initial,
      currentStatement: currentStatements[0],
      setupBinding: setupCall.callee.name,
      inputBindings: inputs.map((i) => i.name),
    },
  };
}
/** Check authored literal values and their own data descriptors at the moment the fixture consumes them. */
export function assertRecordsFixtureLiterals(values, descriptor) {
  const fail = () => {
    throw Object.assign(new Error('changed-records-fixture-input'), {
      qualificationCode: 'changed-records-fixture-input',
    });
  };
  const ok = (condition) => {
    if (!condition) fail();
  };
  ok(values && typeof values === 'object' && descriptor?.version === 1 && Array.isArray(descriptor.inputs));
  const expectedNames = descriptor.inputs.map((item) => item.name);
  ok(new Set(expectedNames).size === expectedNames.length);
  const own = Reflect.ownKeys(values);
  ok(own.length === expectedNames.length && own.every((key) => typeof key === 'string' && expectedNames.includes(key)));
  function compare(actual, expected) {
    if (expected === null || typeof expected !== 'object') {
      ok(Object.is(actual, expected));
      return;
    }
    const array = Array.isArray(expected);
    ok(
      actual &&
        typeof actual === 'object' &&
        Array.isArray(actual) === array &&
        Object.getPrototypeOf(actual) === (array ? Array.prototype : Object.prototype),
    );
    const keys = Reflect.ownKeys(expected),
      actualKeys = Reflect.ownKeys(actual);
    ok(
      keys.length === actualKeys.length &&
        actualKeys.every((key, index) => typeof key === 'string' && keys[index] === key),
    );
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(actual, key),
        e = Object.getOwnPropertyDescriptor(expected, key);
      ok(
        d &&
          e &&
          Object.hasOwn(d, 'value') &&
          d.enumerable === e.enumerable &&
          d.configurable === e.configurable &&
          d.writable === e.writable,
      );
      compare(d.value, e.value);
    }
  }
  for (const item of descriptor.inputs) {
    const d = Object.getOwnPropertyDescriptor(values, item.name);
    ok(d && Object.hasOwn(d, 'value') && d.enumerable && d.configurable && d.writable);
    compare(d.value, item.expected);
  }
}
