import { hashAst as hash } from './parity-ast-utils.mjs';
// Verify one source-preserving strengthening of an owned loopback test fixture.
// This is a fixture certificate, not a parity or network sandbox assertion.
import { createRequire } from 'node:module';
const { parse } = createRequire(import.meta.url)('espree');
const { analyze } = createRequire(import.meta.url)('eslint-scope');
const same = (a, b) => hash(a) === hash(b);
const requireProof = (value) => {
  if (!value)
    throw Object.assign(new Error('unsupported-loopback-fixture-slice'), {
      qualificationCode: 'unsupported-loopback-fixture-slice',
    });
};
function walk(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node, parent);
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value]) if (child?.type) walk(child, fn, node);
}
function suiteFor(ast, row, suiteName) {
  const found = [];
  walk(ast, (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee?.name !== suiteName ||
      node.arguments.length !== 2 ||
      node.arguments[0]?.type !== 'Literal' ||
      node.arguments[1]?.type !== 'ArrowFunctionExpression' ||
      node.arguments[1].async ||
      node.arguments[1].params.length ||
      node.arguments[1].body.type !== 'BlockStatement'
    )
      return;
    let contains = false;
    walk(node.arguments[1].body, (child) => {
      if (child === row.node) contains = true;
    });
    if (contains) found.push(node);
  });
  requireProof(found.length === 1);
  return found[0];
}
function parseStatement(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body[0];
}
function inspect(ast, row) {
  const testImport = ast.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === 'node:test');
  requireProof(testImport.length === 1 && testImport[0].specifiers.every((s) => s.type === 'ImportSpecifier'));
  const names = Object.fromEntries(testImport[0].specifiers.map((s) => [s.imported.name, s.local.name]));
  requireProof(
    testImport[0].specifiers.length === 4 && ['describe', 'it', 'before', 'after'].every((key) => names[key]),
  );
  const suite = suiteFor(ast, row, names.describe),
    statements = suite.arguments[1].body.body;
  const hook = (name) => {
    const calls = statements.filter(
      (s) =>
        s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' && s.expression.callee.name === name,
    );
    requireProof(calls.length === 1 && calls[0].expression.arguments.length === 1);
    const fn = calls[0].expression.arguments[0];
    requireProof(
      fn.type === 'ArrowFunctionExpression' && fn.async && !fn.params.length && fn.body.type === 'BlockStatement',
    );
    return calls[0].expression;
  };
  const before = hook(names.before),
    after = hook(names.after);
  const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const moduleScope = scopes.scopes.find((scope) => scope.type === 'module');
  const hookReferences = new Map();
  for (const name of [names.describe, names.it, names.before, names.after]) {
    const binding = moduleScope.variables.find((v) => v.name === name);
    requireProof(binding?.defs.length === 1 && binding.defs[0].type === 'ImportBinding');
    hookReferences.set(
      name,
      binding.references.map((ref) => ref.identifier),
    );
    for (const ref of binding.references) {
      let parent = null;
      walk(ast, (node, p) => {
        if (node === ref.identifier) parent = p;
      });
      requireProof(parent?.type === 'CallExpression' && parent.callee === ref.identifier);
    }
  }
  const directTests = [...statements, ...ast.body]
    .filter(
      (s) =>
        s.type === 'ExpressionStatement' &&
        s.expression?.type === 'CallExpression' &&
        s.expression.callee?.name === names.it,
    )
    .map((s) => s.expression);
  requireProof(
    directTests.every(
      (call) =>
        call.arguments.length === 2 &&
        ['ArrowFunctionExpression', 'FunctionExpression'].includes(call.arguments[1]?.type) &&
        call.arguments[1].params.length === 0,
    ),
  );
  requireProof(
    hookReferences.get(names.it).every((identifier) => directTests.some((call) => call.callee === identifier)),
  );
  const selectedHookIds = new Set([suite.callee, before.callee, after.callee]);
  const otherHooks = [names.describe, names.before, names.after]
    .flatMap((name) => hookReferences.get(name))
    .filter((identifier) => !selectedHookIds.has(identifier));
  return { suite, before, after, testImport, names, otherHooks };
}
/** Validate exact baseline-to-current hook strengthening. Callers must separately validate source closure and pin full registration context. */
export function analyzeLoopbackFixtureSlice({ baselineAst, currentAst, selected, implementationSources = [] }) {
  requireProof(Array.isArray(selected) && selected.length === 1 && selected[0].old && selected[0].current);
  const old = inspect(baselineAst, selected[0].old),
    current = inspect(currentAst, selected[0].current);
  requireProof(same(old.suite.arguments[0], current.suite.arguments[0]) && same(old.testImport, current.testImport));
  const body = old.before.arguments[0].body.body,
    nextBody = current.before.arguments[0].body.body;
  requireProof(body.length > 1 && nextBody.length === body.length + 1);
  const assignment = body[0]?.expression,
    capture = nextBody[0]?.expression;
  const env = assignment?.left;
  requireProof(
    assignment?.type === 'AssignmentExpression' &&
      assignment.operator === '=' &&
      assignment.right?.type === 'Literal' &&
      typeof assignment.right.value === 'string' &&
      env?.type === 'MemberExpression' &&
      env.computed &&
      env.property?.type === 'Identifier' &&
      env.object?.type === 'MemberExpression' &&
      !env.object.computed &&
      env.object.object?.name === 'process' &&
      env.object.property?.name === 'env',
  );
  const secret = env.property.name,
    previous = capture?.left?.name;
  requireProof(
    capture?.type === 'AssignmentExpression' &&
      capture.operator === '=' &&
      capture.left?.type === 'Identifier' &&
      same(capture.right, env),
  );
  const currentDeclarations = current.suite.arguments[1].body.body.filter(
    (s) =>
      s.type === 'VariableDeclaration' &&
      s.kind === 'let' &&
      s.declarations.length === 1 &&
      s.declarations[0].id.name === previous &&
      !s.declarations[0].init,
  );
  requireProof(
    currentDeclarations.length === 1 &&
      !old.suite.arguments[1].body.body.some(
        (s) => s.type === 'VariableDeclaration' && s.declarations.some((d) => d.id?.name === previous),
      ),
  );
  const secretDecl = currentAst.body.filter(
    (s) =>
      s.type === 'VariableDeclaration' &&
      s.kind === 'const' &&
      s.declarations.length === 1 &&
      s.declarations[0].id?.name === secret &&
      s.declarations[0].init?.type === 'Literal' &&
      typeof s.declarations[0].init.value === 'string',
  );
  requireProof(
    secretDecl.length === 1 &&
      same(
        secretDecl[0],
        baselineAst.body.find(
          (s) => s.type === 'VariableDeclaration' && s.declarations.some((d) => d.id?.name === secret),
        ),
      ),
  );
  let startOld, startCurrent, addedHost;
  walk(current.before, (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee?.type !== 'Identifier' ||
      node.arguments.length !== 1 ||
      node.arguments[0]?.type !== 'ObjectExpression'
    )
      return;
    const props = node.arguments[0].properties.filter((p) => !p.computed && p.key?.name === 'host');
    if (props.length === 1 && props[0].value?.type === 'Literal' && props[0].value.value === '127.0.0.1') {
      requireProof(!startCurrent);
      startCurrent = node;
      addedHost = props[0];
    }
  });
  requireProof(startCurrent);
  const imported = currentAst.body.filter(
    (s) =>
      s.type === 'ImportDeclaration' &&
      implementationSources.includes(s.source.value) &&
      s.specifiers.some((x) => x.local?.name === startCurrent.callee.name),
  );
  requireProof(
    imported.length === 1 &&
      startCurrent.arguments[0].properties.every(
        (p) => p.type === 'Property' && !p.computed && p.kind === 'init' && !p.method,
      ) &&
      new Set(startCurrent.arguments[0].properties.map((p) => p.key.name ?? p.key.value)).size ===
        startCurrent.arguments[0].properties.length,
  );
  let shadow = false;
  walk(current.suite, (node) => {
    if (
      (node.type === 'VariableDeclarator' || node.type === 'FunctionDeclaration') &&
      node.id?.name === startCurrent.callee.name
    )
      shadow = true;
  });
  requireProof(!shadow);
  const scopeManager = analyze(currentAst, { ecmaVersion: 2022, sourceType: 'module' });
  const startRef = scopeManager.scopes
    .flatMap((scope) => scope.references)
    .find((ref) => ref.identifier === startCurrent.callee);
  requireProof(
    startRef?.resolved?.defs.length === 1 &&
      startRef.resolved.defs[0].type === 'ImportBinding' &&
      startRef.resolved.defs[0].parent === imported[0],
  );
  const hookNodes = new Set();
  walk(current.before, (node) => hookNodes.add(node));
  walk(current.after, (node) => hookNodes.add(node));
  const references = scopeManager.scopes
    .flatMap((scope) => scope.references)
    .filter((ref) => hookNodes.has(ref.identifier));
  const verifySecretReferences = () => {
    for (const ref of references) {
      if (ref.identifier.name === 'process') requireProof(!ref.resolved);
      if (ref.identifier.name === secret)
        requireProof(ref.resolved?.defs.length === 1 && ref.resolved.defs[0].parent === secretDecl[0]);
      if (ref.identifier.name === previous)
        requireProof(ref.resolved?.defs.length === 1 && ref.resolved.defs[0].parent === currentDeclarations[0]);
    }
  };
  verifySecretReferences();
  walk(old.before, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee?.name === startCurrent.callee.name &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type === 'ObjectExpression'
    ) {
      requireProof(!startOld);
      startOld = node;
    }
  });
  requireProof(startOld && !startOld.arguments[0].properties.some((p) => p.key?.name === 'host'));
  const normalized = (node) => {
    if (node === addedHost) return null;
    if (Array.isArray(node)) return node.filter((x) => x !== addedHost).map(normalized);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, normalized(v)]));
  };
  requireProof(same(body, normalized(nextBody.slice(1))));
  const oldAfter = old.after.arguments[0].body.body;
  requireProof(oldAfter.length === 2 && same(oldAfter[0], parseStatement(`delete process.env[${secret}];`)));
  const close = oldAfter[1];
  requireProof(
    close?.type === 'ExpressionStatement' &&
      close.expression?.type === 'AwaitExpression' &&
      close.expression.argument?.type === 'ChainExpression',
  );
  const api = close.expression.argument.expression?.callee?.object?.name;
  requireProof(api && same(close, parseStatement(`await ${api}?.close();`)));
  const verifyBothStartupClosures = () => {
    for (const [version, start, ast] of [
      [old, startOld, baselineAst],
      [current, startCurrent, currentAst],
    ]) {
      let parent, grandparent;
      walk(version.before, (node, p) => {
        if (node === start) parent = p;
      });
      walk(version.before, (node, p) => {
        if (node === parent) grandparent = p;
      });
      requireProof(
        parent?.type === 'AwaitExpression' &&
          grandparent?.type === 'AssignmentExpression' &&
          grandparent.operator === '=' &&
          grandparent.left?.name === api &&
          grandparent.right === parent,
      );
      const refs = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }).scopes.flatMap(
        (scope) => scope.references,
      );
      const assigned = refs.find((ref) => ref.identifier === grandparent.left)?.resolved;
      const closeRefs = [];
      walk(version.after, (node) => {
        if (node.type === 'Identifier' && node.name === api)
          closeRefs.push(refs.find((ref) => ref.identifier === node));
      });
      requireProof(
        assigned?.defs.length === 1 &&
          assigned.defs[0].type === 'Variable' &&
          closeRefs.length === 1 &&
          closeRefs[0]?.resolved === assigned,
      );
    }
  };
  verifyBothStartupClosures();
  const expectedAfter = parseStatement(
    `try { await ${api}?.close(); } finally { if (${previous} === undefined) delete process.env[${secret}]; else process.env[${secret}] = ${previous}; }`,
  );
  requireProof(
    current.after.arguments[0].body.body.length === 1 && same(current.after.arguments[0].body.body[0], expectedAfter),
  );
  let previousUses = 0;
  walk(current.suite, (node) => {
    if (node.type === 'Identifier' && node.name === previous) previousUses++;
  });
  requireProof(previousUses === 4);
  const nodeSet = (version) => ({
    recognizedIdentifiers: new Set([version.before.callee, version.after.callee, version.suite.callee]),
    isolatedIdentifiers: new Set(),
    recognizedBuiltinImports: new Set(),
    handledInputSources: new Set(),
    dependencies: [],
    fixtures: [],
    requiresAllRegistrations: true,
    completeHookCoverage: version.otherHooks.length === 0,
  });
  return {
    old: nodeSet(old),
    current: nodeSet(current),
    normalization: {
      oldSuite: old.suite,
      currentSuite: current.suite,
      oldBefore: old.before,
      currentBefore: current.before,
      oldAfter: old.after,
      currentAfter: current.after,
      addedDeclaration: currentDeclarations[0],
    },
    descriptor: {
      suiteTitleAstSha256: hash(old.suite.arguments[0]),
      baselineBeforeAstSha256: hash(old.before),
      currentBeforeAstSha256: hash(current.before),
      baselineAfterAstSha256: hash(old.after),
      currentAfterAstSha256: hash(current.after),
      secretName: secret,
      host: '127.0.0.1',
      requiresAllRegistrations: true,
    },
  };
}

/** Compare an authored literal state producer in two modules, without exempting inputs. */
export function analyzeLiteralStateProducer({ baselineAst, currentAst, producerName, implementationSources = [] }) {
  const inspectProducer = (ast) => {
    const functions = ast.body.filter((node) => node.type === 'FunctionDeclaration' && node.id?.name === producerName);
    requireProof(
      functions.length === 1 && !functions[0].async && !functions[0].generator && !functions[0].params.length,
    );
    const fn = functions[0],
      body = fn.body.body,
      first = body[0],
      last = body.at(-1);
    requireProof(
      first?.type === 'VariableDeclaration' &&
        first.kind === 'const' &&
        first.declarations.length === 1 &&
        first.declarations[0].id.type === 'Identifier',
    );
    const variable = first.declarations[0].id.name,
      factory = first.declarations[0].init;
    requireProof(
      factory?.type === 'CallExpression' && factory.callee?.type === 'Identifier' && !factory.arguments.length,
    );
    const imports = ast.body.filter(
      (node) =>
        node.type === 'ImportDeclaration' &&
        implementationSources.includes(node.source.value) &&
        node.specifiers.some((item) => item.local.name === factory.callee.name),
    );
    requireProof(imports.length === 1 && last?.type === 'ReturnStatement' && last.argument?.name === variable);
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }),
      refs = scopes.scopes.flatMap((scope) => scope.references);
    const reference = refs.find((ref) => ref.identifier === factory.callee);
    requireProof(
      reference?.resolved?.defs.length === 1 &&
        reference.resolved.defs[0].type === 'ImportBinding' &&
        reference.resolved.defs[0].parent === imports[0],
    );
    const literal = (node) => {
      if (node?.type === 'Literal')
        return node.value === null || ['string', 'boolean', 'number'].includes(typeof node.value);
      if (node?.type === 'Identifier') {
        const ref = refs.find((item) => item.identifier === node),
          def = ref?.resolved?.defs[0];
        return (
          ref?.resolved?.defs.length === 1 &&
          def?.type === 'Variable' &&
          def.parent.kind === 'const' &&
          def.node.init?.type === 'Literal' &&
          ['string', 'boolean', 'number'].includes(typeof def.node.init.value) &&
          !ref.resolved.references.some((item) => item.isWrite() && !item.init)
        );
      }
      if (node?.type === 'ArrayExpression') return node.elements.every(literal);
      if (node?.type === 'ObjectExpression')
        return node.properties.every(
          (p) =>
            p.type === 'Property' &&
            !p.computed &&
            !p.method &&
            !p.shorthand &&
            p.kind === 'init' &&
            !['__proto__', 'prototype', 'constructor'].includes(p.key.name ?? p.key.value) &&
            literal(p.value),
        );
      return false;
    };
    for (const statement of body.slice(1, -1)) {
      const expr = statement.type === 'ExpressionStatement' && statement.expression;
      requireProof(expr?.type === 'AssignmentExpression' && expr.operator === '=' && literal(expr.right));
      let target = expr.left,
        depth = 0;
      while (target?.type === 'MemberExpression') {
        requireProof(
          !target.computed &&
            target.property?.type === 'Identifier' &&
            !['__proto__', 'prototype', 'constructor'].includes(target.property.name),
        );
        target = target.object;
        depth++;
      }
      requireProof(depth >= 1 && target?.type === 'Identifier' && target.name === variable);
      const ref = refs.find((item) => item.identifier === target);
      requireProof(ref?.resolved?.defs.length === 1 && ref.resolved.defs[0].node === first.declarations[0]);
    }
    return { node: fn, factory: factory.callee, hash: hash(fn) };
  };
  const baseline = inspectProducer(baselineAst),
    current = inspectProducer(currentAst);
  requireProof(baseline.hash === current.hash);
  return { baseline, current, producerAstSha256: baseline.hash };
}

/** Verify the owned-origin node:http forwarding function used by this bounded fixture family. */
export function analyzeOwnedHttpTransport({ baselineAst, currentAst, selected }) {
  requireProof(selected.length === 1);
  const signature = parseStatement(`function send(method, path, { headers = {}, body, auth = true } = {}) {
    const url = new URL(\`\${api.origin}\${path}\`);
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const all = { ...(auth ? { authorization: \`Bearer \${token}\` } : {}), accept: 'application/json', ...headers };
    if (payload !== null && all['content-type'] === undefined) all['content-type'] = 'application/json; charset=utf-8';
    if (payload !== null) all['content-length'] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      const req = request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: all }, (res) => {
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      }); req.on('error', reject); if (payload !== null) req.write(payload); req.end();
    });
  }`);
  function inspectTransport(ast, row) {
    const suite = suiteFor(ast, row, 'describe');
    const body = suite.arguments[1].body.body;
    const declarations = body.filter((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'send');
    requireProof(declarations.length === 1 && same(declarations[0], signature));
    const imports = ast.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === 'node:http');
    requireProof(
      imports.length === 1 &&
        imports[0].specifiers.length === 1 &&
        imports[0].specifiers[0].type === 'ImportSpecifier' &&
        imports[0].specifiers[0].imported.name === 'request' &&
        imports[0].specifiers[0].local.name === 'request',
    );
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }),
      refs = scopes.scopes.flatMap((scope) => scope.references);
    const requestRefs = refs.filter(
      (ref) => ref.identifier.name === 'request' && ref.resolved?.defs[0]?.parent === imports[0],
    );
    requireProof(requestRefs.length === 1);
    let requestWithin = false;
    walk(declarations[0], (node) => {
      if (node === requestRefs[0].identifier) requestWithin = true;
    });
    requireProof(requestWithin);
    for (const name of ['URL', 'Promise', 'Buffer', 'JSON'])
      for (const ref of refs.filter((item) => item.identifier.name === name)) {
        let within = false;
        walk(declarations[0], (node) => {
          if (node === ref.identifier) within = true;
        });
        if (within) requireProof(!ref.resolved);
      }
    return {
      declaration: declarations[0],
      importNode: imports[0],
      requestIdentifier: requestRefs[0].identifier,
      hash: hash(declarations[0]),
    };
  }
  const baseline = inspectTransport(baselineAst, selected[0].old),
    current = inspectTransport(currentAst, selected[0].current);
  requireProof(baseline.hash === current.hash);
  return { baseline, current, transportAstSha256: baseline.hash };
}

function validateRoutingLoopEnvironment(ast, refs) {
  const dangerous = new Set([
    'Array',
    'Object',
    'Reflect',
    'Symbol',
    'Proxy',
    'globalThis',
    'global',
    'Function',
    'eval',
  ]);
  walk(ast, (node) => {
    requireProof(!['ImportExpression', 'WithStatement', 'ClassDeclaration', 'ClassExpression'].includes(node.type));
    if (node.type === 'Identifier') requireProof(!dangerous.has(node.name));
    if (node.type === 'Property')
      requireProof(
        !node.computed && !['prototype', '__proto__', 'constructor'].includes(node.key.name ?? node.key.value),
      );
    if (node.type === 'MemberExpression') {
      let key;
      if (!node.computed) key = node.property.name;
      else if (node.property.type === 'Literal') key = node.property.value;
      else if (node.property.type === 'Identifier') {
        const ref = refs.find((item) => item.identifier === node.property),
          variable = ref?.resolved,
          def = variable?.defs[0];
        requireProof(
          variable?.defs.length === 1 &&
            def?.type === 'Variable' &&
            def.node.id?.type === 'Identifier' &&
            def.parent?.kind === 'const' &&
            def.node.init?.type === 'Literal' &&
            typeof def.node.init.value === 'string' &&
            !variable.references.some((item) => item.isWrite() && !item.init),
        );
        key = def.node.init.value;
      } else requireProof(false);
      requireProof(!['prototype', '__proto__', 'constructor'].includes(key));
    }
  });
}

/** Check routing components; the caller must still prove ambient and authentication inputs. */
export function analyzeRoutingComponents({ baselineAst, currentAst, selected, implementationSources = [] }) {
  const hooks = analyzeLoopbackFixtureSlice({ baselineAst, currentAst, selected, implementationSources });
  requireProof(hooks.old.completeHookCoverage && hooks.current.completeHookCoverage);
  const state = analyzeLiteralStateProducer({ baselineAst, currentAst, producerName: 'schema', implementationSources });
  const transport = analyzeOwnedHttpTransport({ baselineAst, currentAst, selected });
  const certificates = [];
  const verifyRoutingVersion = ([ast, row, fixture, producer, forwarder]) => {
    const suite = suiteFor(ast, row, 'describe'),
      body = suite.arguments[1].body.body;
    const before = body.find(
      (s) => s.type === 'ExpressionStatement' && s.expression.callee?.name === 'before',
    )?.expression;
    const after = body.find(
      (s) => s.type === 'ExpressionStatement' && s.expression.callee?.name === 'after',
    )?.expression;
    const record = body.filter(
      (s) =>
        s.type === 'VariableDeclaration' &&
        s.kind === 'const' &&
        s.declarations.length === 1 &&
        s.declarations[0].id?.name === 'record',
    );
    requireProof(before && after && record.length === 1);
    const rec = record[0].declarations[0].init;
    requireProof(
      rec?.type === 'ArrowFunctionExpression' &&
        !rec.async &&
        rec.params.length === 1 &&
        rec.params[0].type === 'AssignmentPattern' &&
        rec.params[0].left.type === 'Identifier' &&
        rec.params[0].right.type === 'Identifier' &&
        rec.body.type === 'TemplateLiteral' &&
        rec.body.quasis[0].value.cooked === '' &&
        rec.body.expressions.length === 2 &&
        rec.body.expressions[0].type === 'Identifier' &&
        rec.body.expressions[1].name === rec.params[0].left.name,
    );
    const literalDecl = (name) => {
      const found = ast.body.filter(
        (s) =>
          s.type === 'VariableDeclaration' &&
          s.kind === 'const' &&
          s.declarations.length === 1 &&
          s.declarations[0].id?.name === name &&
          s.declarations[0].init?.type === 'Literal' &&
          typeof s.declarations[0].init.value === 'string',
      );
      requireProof(found.length === 1);
      return found[0].declarations[0].init.value;
    };
    requireProof(
      literalDecl(rec.body.expressions[0].name).startsWith('/') && literalDecl(rec.params[0].right.name).length > 0,
    );
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }),
      refs = scopes.scopes.flatMap((scope) => scope.references);
    const parentMap = new Map();
    walk(ast, (node, parent) => parentMap.set(node, parent));
    const verifyStateIdentifiers = () => {
      for (const name of ['api', 'token']) {
        const decls = body.filter(
          (s) =>
            s.type === 'VariableDeclaration' &&
            s.kind === 'let' &&
            s.declarations.length === 1 &&
            s.declarations[0].id?.name === name &&
            !s.declarations[0].init,
        );
        requireProof(decls.length === 1);
        const variable = scopes.scopes
          .flatMap((scope) => scope.variables)
          .find((v) => v.identifiers.includes(decls[0].declarations[0].id));
        const writes = variable?.references.filter((ref) => ref.isWrite());
        requireProof(writes?.length === 1);
        let inBefore = false;
        walk(before, (node) => {
          if (node === writes[0].identifier) inBefore = true;
        });
        requireProof(inBefore);
        for (const ref of variable.references.filter((r) => r.isRead())) {
          const parent = parentMap.get(ref.identifier);
          if (name === 'api') {
            requireProof(
              parent?.type === 'MemberExpression' &&
                parent.object === ref.identifier &&
                !parent.computed &&
                ['origin', 'tenantId', 'close'].includes(parent.property.name),
            );
            const owner = parentMap.get(parent);
            requireProof(
              !(owner?.type === 'AssignmentExpression' && owner.left === parent) &&
                owner?.type !== 'UpdateExpression' &&
                !(owner?.type === 'UnaryExpression' && owner.operator === 'delete'),
            );
            if (parent.property.name === 'close') {
              let inAfter = false;
              walk(after, (node) => {
                if (node === parent) inAfter = true;
              });
              requireProof(inAfter);
            }
          } else {
            let inSend = false;
            walk(forwarder.declaration, (node) => {
              if (node === ref.identifier) inSend = true;
            });
            requireProof(inSend);
          }
        }
      }
    };
    verifyStateIdentifiers();
    const verifyRecordBindings = () => {
      for (const id of [rec.body.expressions[0], rec.params[0].right]) {
        const ref = refs.find((r) => r.identifier === id);
        requireProof(
          ref?.resolved?.defs.length === 1 &&
            ref.resolved.defs[0].type === 'Variable' &&
            ref.resolved.defs[0].parent.kind === 'const' &&
            ref.resolved.defs[0].node.init?.type === 'Literal' &&
            !ref.resolved.references.some((r) => r.isWrite() && !r.init),
        );
      }
    };
    verifyRecordBindings();
    const callback = row.callback ?? row.node.arguments[1];
    const insideCallback = new Set();
    walk(callback, (node) => insideCallback.add(node));
    const paths = [],
      provenLoops = new Set();
    const product = (a, b) => {
      requireProof(a.length * b.length <= 256);
      return a.flatMap((left) => b.map((right) => left + right));
    };
    const evaluateIdentifier = (node, overrides) => {
      if (overrides.has(node.name)) return overrides.get(node.name);
      const ref = refs.find((item) => item.identifier === node),
        variable = ref?.resolved,
        def = variable?.defs[0];
      requireProof(
        variable?.defs.length === 1 &&
          def?.type === 'Variable' &&
          def.node.id?.type === 'Identifier' &&
          def.node.id.name === node.name &&
          def.parent?.kind === 'const' &&
          def.parent.declarations.length === 1 &&
          !variable.references.some((item) => item.isWrite() && !item.init),
      );
      if (def.node.init?.type === 'Literal' && typeof def.node.init.value === 'string') return [def.node.init.value];
      const loop = parentMap.get(def.parent);
      requireProof(
        !def.node.init &&
          loop?.type === 'ForOfStatement' &&
          !loop.await &&
          loop.left === def.parent &&
          insideCallback.has(loop) &&
          loop.right?.type === 'ArrayExpression' &&
          loop.right.elements.length > 0 &&
          loop.right.elements.length <= 64 &&
          loop.right.elements.every((item) => item?.type === 'Literal' && typeof item.value === 'string'),
      );
      provenLoops.add(loop);
      return loop.right.elements.map((item) => item.value);
    };
    const evaluate = (node, overrides = new Map()) => {
      if (node?.type === 'Literal' && typeof node.value === 'string') return [node.value];
      if (node?.type === 'Identifier') return evaluateIdentifier(node, overrides);
      if (node?.type === 'TemplateLiteral') {
        requireProof(
          node.quasis.length === node.expressions.length + 1 &&
            node.quasis.every((part) => typeof part.value.cooked === 'string'),
        );
        let values = [node.quasis[0].value.cooked];
        for (let i = 0; i < node.expressions.length; i++)
          values = product(product(values, evaluate(node.expressions[i], overrides)), [
            node.quasis[i + 1].value.cooked,
          ]);
        return values;
      }
      if (node?.type === 'BinaryExpression' && node.operator === '+')
        return product(evaluate(node.left, overrides), evaluate(node.right, overrides));
      if (node?.type === 'CallExpression' && node.callee?.name === 'record' && node.arguments.length === 0) {
        const ref = refs.find((item) => item.identifier === node.callee);
        requireProof(ref?.resolved?.defs.length === 1 && ref.resolved.defs[0].node === record[0].declarations[0]);
        return evaluate(rec.body, new Map([[rec.params[0].left.name, evaluate(rec.params[0].right)]]));
      }
      requireProof(false);
    };
    walk(callback, (node) => {
      if (node.type === 'CallExpression' && node.callee?.name === 'send') {
        requireProof(
          node.arguments.length >= 2 &&
            node.arguments[0].type === 'Literal' &&
            typeof node.arguments[0].value === 'string',
        );
        const values = evaluate(node.arguments[1]);
        requireProof(
          values.length > 0 &&
            values.every(
              (value) =>
                value.startsWith('/') &&
                !value.startsWith('//') &&
                !value.includes(String.fromCodePoint(92)) &&
                ![...value].some((character) => character.codePointAt(0) <= 32 || character.codePointAt(0) === 127) &&
                new URL('http://127.0.0.1:4321' + value).origin === 'http://127.0.0.1:4321',
            ),
        );
        paths.push({ method: node.arguments[0].value, valuesSha256: hash(values), count: values.length });
      }
    });
    requireProof(paths.length > 0);
    const loopCertificates = [];
    const validateProvenLoops = () => {
      if (!provenLoops.size) return;
      validateRoutingLoopEnvironment(ast, refs);
      const assertionImports = ast.body.filter(
        (node) =>
          node.type === 'ImportDeclaration' &&
          ['node:assert', 'node:assert/strict'].includes(node.source.value) &&
          node.specifiers.some((item) => item.type === 'ImportDefaultSpecifier' && item.local.name === 'assert'),
      );
      requireProof(assertionImports.length === 1);
      const errors = body.filter(
        (node) =>
          node.type === 'VariableDeclaration' &&
          node.declarations.length === 1 &&
          node.declarations[0].id?.name === 'error',
      );
      requireProof(
        errors.length === 1 &&
          same(errors[0], parseStatement('const error = async (response) => (await response.json()).error;')),
      );
      const validateLoop = (loop) => {
        const parts = loop.body?.type === 'BlockStatement' ? loop.body.body : [];
        requireProof(
          parts.length === 3 &&
            parts[0].type === 'VariableDeclaration' &&
            parts[0].kind === 'const' &&
            parts[0].declarations.length === 1,
        );
        const declaration = parts[0].declarations[0],
          responseName = declaration.id?.name,
          awaited = declaration.init;
        requireProof(
          declaration.id?.type === 'Identifier' &&
            awaited?.type === 'AwaitExpression' &&
            awaited.argument?.type === 'CallExpression' &&
            awaited.argument.callee?.name === 'send' &&
            awaited.argument.arguments.length === 2,
        );
        const first = parts[1].type === 'ExpressionStatement' && parts[1].expression,
          second = parts[2].type === 'ExpressionStatement' && parts[2].expression;
        const name = loop.left.declarations[0].id.name;
        requireProof(
          first?.type === 'CallExpression' &&
            first.callee?.type === 'MemberExpression' &&
            !first.callee.computed &&
            first.callee.object?.name === 'assert' &&
            first.callee.property?.name === 'equal' &&
            first.arguments.length === 3 &&
            same(
              first.arguments[0],
              parseStatement(`assert.equal(${responseName}.status, 0, ${name});`).expression.arguments[0],
            ) &&
            first.arguments[1].type === 'Literal' &&
            typeof first.arguments[1].value === 'number' &&
            first.arguments[2]?.name === name,
        );
        requireProof(
          second?.type === 'CallExpression' &&
            second.callee?.type === 'MemberExpression' &&
            !second.callee.computed &&
            second.callee.object?.name === 'assert' &&
            second.callee.property?.name === 'deepEqual' &&
            second.arguments.length === 3 &&
            same(
              second.arguments[0],
              parseStatement(`assert.deepEqual(await error(${responseName}), {}, ${name});`).expression.arguments[0],
            ) &&
            second.arguments[1].type === 'ObjectExpression' &&
            second.arguments[2]?.name === name,
        );
        requireProof(
          second.arguments[1].properties.every(
            (property) =>
              property.type === 'Property' &&
              property.kind === 'init' &&
              !property.computed &&
              !property.method &&
              !property.shorthand &&
              !['__proto__', 'constructor', 'prototype'].includes(property.key.name ?? property.key.value) &&
              evaluate(property.value).length > 0,
          ),
        );
        for (const assertion of [first, second]) {
          const ref = refs.find((item) => item.identifier === assertion.callee.object);
          requireProof(ref?.resolved?.defs.length === 1 && ref.resolved.defs[0].parent === assertionImports[0]);
        }
        const errorRef = refs.find((item) => item.identifier === second.arguments[0].argument.callee);
        requireProof(
          errorRef?.resolved?.defs.length === 1 && errorRef.resolved.defs[0].node === errors[0].declarations[0],
        );
        const responseVar = scopes.scopes
          .flatMap((scope) => scope.variables)
          .find((variable) => variable.identifiers.includes(declaration.id));
        requireProof(
          responseVar?.references.filter((ref) => ref.isRead()).length === 2 &&
            !responseVar.references.some((ref) => ref.isWrite() && !ref.init),
        );
        const nameVar = refs.find((ref) => ref.identifier === first.arguments[2])?.resolved;
        requireProof(
          nameVar &&
            refs.find((ref) => ref.identifier === second.arguments[2])?.resolved === nameVar &&
            nameVar.defs[0].node === loop.left.declarations[0],
        );
        loopCertificates.push({
          loopAstSha256: hash(loop),
          assertionAstSha256: [hash(first), hash(second)],
          casesSha256: hash(loop.right.elements.map((item) => item.value)),
          caseCount: loop.right.elements.length,
        });
      };
      for (const loop of provenLoops) validateLoop(loop);
    };
    validateProvenLoops();
    const selectedNodes = new Set();
    walk(callback, (node) => selectedNodes.add(node));
    const verifySelectedReferences = () => {
      for (const ref of refs.filter(
        (r) => selectedNodes.has(r.identifier) && ['send', 'record'].includes(r.identifier.name),
      )) {
        requireProof(
          ref.resolved?.defs.length === 1 &&
            (ref.identifier.name === 'send'
              ? ref.resolved.defs[0].node === forwarder.declaration
              : ref.resolved.defs[0].node === record[0].declarations[0]),
        );
      }
    };
    verifySelectedReferences();

    const schemaRefs = refs.filter((ref) => ref.resolved?.defs.some((def) => def.node === producer.node));
    requireProof(
      schemaRefs.length === 1 &&
        parentMap.get(schemaRefs[0].identifier)?.type === 'CallExpression' &&
        parentMap.get(schemaRefs[0].identifier).callee === schemaRefs[0].identifier &&
        parentMap.get(schemaRefs[0].identifier).arguments.length === 0,
    );
    let schemaInBefore = false;
    walk(before, (node) => {
      if (node === schemaRefs[0].identifier) schemaInBefore = true;
    });
    requireProof(schemaInBefore);
    const recordHash = hash(record[0]);
    // All other input channels remain subject to the qualifier's scanner.
    certificates.push({
      recordAstSha256: recordHash,
      paths,
      loops: loopCertificates,
      stateAstSha256: state.producerAstSha256,
      transportAstSha256: transport.transportAstSha256,
    });
    fixture.transportImport = forwarder.importNode;
    fixture.transportIdentifier = forwarder.requestIdentifier;
  };
  for (const version of [
    [baselineAst, selected[0].old, hooks.old, state.baseline, transport.baseline],
    [currentAst, selected[0].current, hooks.current, state.current, transport.current],
  ])
    verifyRoutingVersion(version);
  requireProof(same(certificates[0], certificates[1]));
  return { ...hooks, routing: certificates[0] };
}

/** Prove the synthetic client-secret exchange derives from the owned API origin. */
export function analyzeRoutingAuthentication({ baselineAst, currentAst, selected }) {
  const descriptors = [];
  for (const [ast, row] of [
    [baselineAst, selected[0].old],
    [currentAst, selected[0].current],
  ]) {
    const suite = suiteFor(ast, row, 'describe'),
      body = suite.arguments[1].body.body;
    const before = body.find(
      (s) => s.type === 'ExpressionStatement' && s.expression.callee?.name === 'before',
    )?.expression;
    requireProof(before);
    const statements = before.arguments[0].body.body;
    const formDecl = statements.find(
      (s) => s.type === 'VariableDeclaration' && s.declarations.length === 1 && s.declarations[0].id?.name === 'form',
    );
    const responseDecl = statements.find(
      (s) =>
        s.type === 'VariableDeclaration' && s.declarations.length === 1 && s.declarations[0].id?.name === 'response',
    );
    const tokenWrite = statements.find(
      (s) =>
        s.type === 'ExpressionStatement' &&
        s.expression.type === 'AssignmentExpression' &&
        s.expression.left?.name === 'token',
    );
    const props = formDecl?.declarations[0]?.init?.arguments[0]?.properties;
    const property = (name) => props?.filter((p) => !p.computed && (p.key.name ?? p.key.value) === name);
    requireProof(props?.length === 4 && property('client_id')?.length === 1 && property('client_secret')?.length === 1);
    const client = property('client_id')[0].value,
      secret = property('client_secret')[0].value;
    requireProof(
      client.type === 'Identifier' &&
        secret.type === 'MemberExpression' &&
        secret.computed &&
        secret.property.type === 'Identifier' &&
        secret.object?.object?.name === 'process' &&
        secret.object?.property?.name === 'env',
    );
    const form = parseStatement(
      `const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: ${client.name}, client_secret: process.env[${secret.property.name}], scope: \`\${api.origin}/.default\` });`,
    );
    const response = parseStatement(
      "const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });",
    );
    const token = parseStatement('token = (await response.json()).access_token;');
    requireProof(same(formDecl, form) && same(responseDecl, response) && same(tokenWrite, token));
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }),
      refs = scopes.scopes.flatMap((scope) => scope.references);
    const fetch = responseDecl.declarations[0].init.argument.callee;
    let formIdentifier, responseIdentifier;
    walk(responseDecl, (node) => {
      if (node.type === 'Identifier' && node.name === 'form') formIdentifier = node;
    });
    walk(tokenWrite, (node) => {
      if (node.type === 'Identifier' && node.name === 'response') responseIdentifier = node;
    });
    const formRef = refs.find((r) => r.identifier === formIdentifier && r.isRead()),
      responseRef = refs.find((r) => r.identifier === responseIdentifier && r.isRead());
    const fetchRef = refs.find((r) => r.identifier === fetch),
      clientRef = refs.find((r) => r.identifier === client);
    requireProof(
      fetchRef &&
        !fetchRef.resolved &&
        formRef?.resolved?.defs[0]?.node === formDecl.declarations[0] &&
        responseRef?.resolved?.defs[0]?.node === responseDecl.declarations[0],
    );
    const definition = clientRef?.resolved?.defs[0];
    requireProof(
      clientRef?.resolved?.defs.length === 1 &&
        definition?.type === 'Variable' &&
        definition.parent.kind === 'const' &&
        definition.node.init?.type === 'Literal' &&
        typeof definition.node.init.value === 'string' &&
        !clientRef.resolved.references.some((r) => r.isWrite() && !r.init),
    );
    const nodeSet = new Set();
    walk(formDecl, (node) => nodeSet.add(node));
    walk(responseDecl, (node) => nodeSet.add(node));
    walk(tokenWrite, (node) => nodeSet.add(node));
    const inExchange = refs.filter((ref) => nodeSet.has(ref.identifier));
    const variableFor = (name) => {
      const declarations = body.filter(
        (s) =>
          s.type === 'VariableDeclaration' &&
          s.kind === 'let' &&
          s.declarations.length === 1 &&
          s.declarations[0].id.name === name,
      );
      requireProof(declarations.length === 1);
      return scopes.scopes
        .flatMap((scope) => scope.variables)
        .find((v) => v.identifiers.includes(declarations[0].declarations[0].id));
    };
    const apiVariable = variableFor('api'),
      tokenVariable = variableFor('token');
    requireProof(inExchange.filter((r) => r.identifier.name === 'api').every((r) => r.resolved === apiVariable));
    requireProof(inExchange.find((r) => r.identifier === tokenWrite.expression.left)?.resolved === tokenVariable);
    requireProof(
      inExchange.filter((r) => ['URLSearchParams', 'process'].includes(r.identifier.name)).every((r) => !r.resolved),
    );
    const secretRef = inExchange.find((r) => r.identifier === secret.property);
    requireProof(
      secretRef?.resolved?.defs.length === 1 &&
        secretRef.resolved.defs[0].type === 'Variable' &&
        secretRef.resolved.defs[0].parent.kind === 'const' &&
        secretRef.resolved.defs[0].node.init?.type === 'Literal' &&
        typeof secretRef.resolved.defs[0].node.init.value === 'string',
    );
    descriptors.push({
      formAstSha256: hash(formDecl),
      responseAstSha256: hash(responseDecl),
      tokenAstSha256: hash(tokenWrite),
      fetchIdentifier: fetch,
      environmentMember: secret.object,
      secretName: secret.property.name,
    });
  }
  requireProof(
    descriptors[0].formAstSha256 === descriptors[1].formAstSha256 &&
      descriptors[0].responseAstSha256 === descriptors[1].responseAstSha256 &&
      descriptors[0].tokenAstSha256 === descriptors[1].tokenAstSha256,
  );
  return { baseline: descriptors[0], current: descriptors[1] };
}

/** Compose the bounded routing proofs and return only the exact owned ambient nodes. */
export function analyzeRoutingInputSlice(args) {
  const result = analyzeRoutingComponents(args),
    auth = analyzeRoutingAuthentication(args);
  for (const [ast, row, side, exchange] of [
    [args.baselineAst, args.selected[0].old, result.old, auth.baseline],
    [args.currentAst, args.selected[0].current, result.current, auth.current],
  ]) {
    requireProof(exchange.secretName === result.descriptor.secretName);
    const suite = suiteFor(ast, row, 'describe'),
      statements = suite.arguments[1].body.body;
    const before = statements.find(
      (s) => s.type === 'ExpressionStatement' && s.expression.callee?.name === 'before',
    )?.expression;
    const after = statements.find(
      (s) => s.type === 'ExpressionStatement' && s.expression.callee?.name === 'after',
    )?.expression;
    const hookNodes = new Set();
    walk(before, (node) => hookNodes.add(node));
    walk(after, (node) => hookNodes.add(node));
    const parents = new Map();
    walk(ast, (node, parent) => parents.set(node, parent));
    const recognizedExternalInputs = new Set();
    function inspectEnvironment(node) {
      const env = parents.get(node),
        key = parents.get(env);
      requireProof(
        hookNodes.has(node) &&
          env?.type === 'MemberExpression' &&
          env.object === node &&
          !env.computed &&
          env.property.name === 'env' &&
          key?.type === 'MemberExpression' &&
          key.object === env &&
          key.computed &&
          key.property?.name === exchange.secretName,
      );
      recognizedExternalInputs.add(env);
    }
    function inspect(node) {
      if (!node?.type) return;
      if (node.type === 'CallExpression' && node.callee?.name === 'it' && node !== row.node) return;
      if (node.type === 'Identifier' && node.name === 'fetch') {
        requireProof(node === exchange.fetchIdentifier);
        recognizedExternalInputs.add(node);
      }
      if (node.type === 'Identifier' && node.name === 'process') inspectEnvironment(node);
      for (const value of Object.values(node))
        for (const child of Array.isArray(value) ? value : [value]) if (child?.type) inspect(child);
    }
    inspect(ast);
    requireProof(
      recognizedExternalInputs.has(exchange.fetchIdentifier) &&
        recognizedExternalInputs.has(exchange.environmentMember),
    );
    side.recognizedExternalInputs = recognizedExternalInputs;
    side.recognizedBuiltinImports.add(side.transportImport);
    side.recognizedIdentifiers.add(side.transportIdentifier);
    delete side.transportImport;
    delete side.transportIdentifier;
  }
  result.routing.authenticationAstSha256 = auth.baseline.responseAstSha256;
  return result;
}
