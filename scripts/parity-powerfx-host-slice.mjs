// Narrow source-only proof for the fixed-clock Power Fx host helpers used by a literal-formula test.
// Caller must validate existing guards and bind the complete module and registration set.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { analyze } = createRequire(import.meta.url)('eslint-scope');
const clean = (x) =>
  Array.isArray(x)
    ? x.map(clean)
    : !x || typeof x !== 'object'
      ? x
      : Object.fromEntries(
          Object.entries(x)
            .filter(([k]) => !['loc', 'range', 'start', 'end', 'raw'].includes(k))
            .map(([k, v]) => [k, clean(v)]),
        );
const hash = (x) =>
  createHash('sha256')
    .update(JSON.stringify(clean(x)))
    .digest('hex');
const fail = () => {
  throw new Error('unsupported-powerfx-host-slice');
};
const check = (x) => {
  if (!x) fail();
};
function walk(node, fn, parent = null) {
  fn(node, parent);
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value]) if (child?.type) walk(child, fn, node);
}
const empty = () => ({
  recognizedIdentifiers: new Set(),
  isolatedIdentifiers: new Set(),
  recognizedBuiltinImports: new Set(),
  handledInputSources: new Set(),
  dependencies: [],
  fixtures: [],
});
const expected = {
  NOW: 'd1c67e4782f35c3d87b871c8d4d015d0e840faf7f05530ea00ed83a686ea6ac3',
  hostOf: 'd0361b7b1e4461148d5f0c56dee4fbeb162b0e3a89fa70bfddb76a8b7b24c3db',
  run: '9f824d7b40a27a4f9000f96a94019ed29a5f93631c6a441c7ca39e1ee72fdb86',
};
export function analyzePowerFxHostSlice({ ast, selected, implementationSources = [] }) {
  try {
    check(selected.length === 1);
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }),
      moduleScope = scopes.scopes.find((s) => s.type === 'module');
    const refs = new Map(),
      parents = new Map();
    for (const scope of scopes.scopes) for (const ref of scope.references) refs.set(ref.identifier, ref.resolved);
    walk(ast, (n, p) => parents.set(n, p));
    const vars = new Map();
    for (const [name, digest] of Object.entries(expected)) {
      const v = moduleScope.variables.find((x) => x.name === name);
      check(
        v?.defs.length === 1 &&
          v.defs[0].type === 'Variable' &&
          v.defs[0].parent.kind === 'const' &&
          hash(v.defs[0].node.init) === digest &&
          !v.references.some((r) => r.isWrite() && !r.init),
      );
      vars.set(name, v);
    }
    const sut = moduleScope.variables.find((x) => x.name === 'powerFxEngine');
    check(
      sut?.defs.length === 1 &&
        sut.defs[0].type === 'ImportBinding' &&
        sut.defs[0].node.imported?.name === 'powerFxEngine' &&
        implementationSources.includes(sut.defs[0].parent.source.value),
    );
    const assertion = moduleScope.variables.find((x) => x.name === 'assert');
    check(
      assertion?.defs.length === 1 &&
        assertion.defs[0].type === 'ImportBinding' &&
        ['node:assert', 'node:assert/strict'].includes(assertion.defs[0].parent.source.value),
    );
    const testBinding = moduleScope.variables.find((x) => x.name === 'test');
    check(
      testBinding?.defs.length === 1 &&
        testBinding.defs[0].type === 'ImportBinding' &&
        testBinding.defs[0].parent.source.value === 'node:test' &&
        testBinding.defs[0].node.type === 'ImportDefaultSpecifier',
    );
    for (const reference of testBinding.references) {
      const call = parents.get(reference.identifier);
      check(
        call?.type === 'CallExpression' &&
          call.callee === reference.identifier &&
          call.arguments.length === 2 &&
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(call.arguments[1]?.type) &&
          !call.arguments[1].async &&
          !call.arguments[1].generator,
      );
    }
    for (const name of ['hostOf', 'run'])
      for (const r of vars.get(name).references)
        if (!r.init) {
          const p = parents.get(r.identifier);
          check(p?.type === 'CallExpression' && p.callee === r.identifier && !p.optional);
        }
    for (const r of sut.references) {
      const p = parents.get(r.identifier),
        call = parents.get(p);
      check(
        p?.type === 'MemberExpression' &&
          p.object === r.identifier &&
          !p.computed &&
          ['evaluateSync', 'checkSync'].includes(p.property.name) &&
          call?.type === 'CallExpression' &&
          call.callee === p,
      );
    }
    walk(ast, (n, p) => {
      if (
        n.type === 'WithStatement' ||
        n.type === 'ImportExpression' ||
        n.type === 'AwaitExpression' ||
        (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(n.type) &&
          (n.async || n.generator))
      )
        fail();
      if (n.type === 'MemberExpression') {
        if (n.computed && n.property?.type !== 'Literal')
          check(
            n.object?.type === 'Identifier' &&
              n.object.name === 'CASES' &&
              refs.get(n.object)?.scope === moduleScope &&
              n.property.type === 'BinaryExpression' &&
              n.property.operator === '-' &&
              n.property.right?.type === 'Literal' &&
              n.property.right.value === 1,
          );
        const key = n.computed ? (n.property?.type === 'Literal' ? n.property.value : null) : n.property.name;
        check(!['constructor', 'prototype', '__proto__'].includes(key));
      }
      if (n.type === 'ObjectPattern')
        for (const prop of n.properties)
          if (prop.type !== 'RestElement')
            check(
              !prop.computed && !['constructor', 'prototype', '__proto__'].includes(prop.key?.name ?? prop.key?.value),
            );
      if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') {
        const target = n.type === 'AssignmentExpression' ? n.left : n.argument;
        check(
          target?.type === 'Identifier' &&
            refs.get(target) &&
            !['module', 'global'].includes(refs.get(target).scope.type),
        );
      }
      if (n.type === 'Identifier' && refs.has(n) && !refs.get(n)) {
        check(['Date', 'JSON', 'URL', 'Map', 'Boolean', 'Set', 'String'].includes(n.name));
        if (n.name === 'Date' || n.name === 'JSON')
          check(
            p?.type === 'MemberExpression' &&
              p.object === n &&
              !p.computed &&
              (n.name === 'Date' ? ['UTC', 'parse'] : ['parse', 'stringify']).includes(p.property.name) &&
              parents.get(p)?.type === 'CallExpression' &&
              parents.get(p).callee === p,
          );
        else check((p?.type === 'NewExpression' || p?.type === 'CallExpression') && p.callee === n);
      }
      if (
        n.type === 'CallExpression' &&
        n.callee?.type === 'MemberExpression' &&
        !n.callee.computed &&
        ['before', 'after', 'beforeEach', 'afterEach', 'only', 'skip'].includes(n.callee.property.name)
      )
        fail();
    });
    const row = selected[0].old,
      cb = row.callback,
      body = cb.body?.body;
    check(!cb.async && !cb.generator && cb.params.length === 0 && body?.length === 3);
    const dec = body[0];
    check(dec.type === 'VariableDeclaration' && dec.kind === 'const' && dec.declarations.length === 1);
    const item = dec.declarations[0],
      init = item.init;
    check(
      item.id.type === 'Identifier' &&
        init?.type === 'CallExpression' &&
        refs.get(init.callee) === vars.get('hostOf') &&
        init.arguments.length === 1,
    );
    const obj = init.arguments[0];
    check(
      obj.type === 'ObjectExpression' &&
        obj.properties.length === 1 &&
        !obj.properties[0].computed &&
        obj.properties[0].key.name === 'timeZone' &&
        obj.properties[0].value.type === 'Literal' &&
        typeof obj.properties[0].value.value === 'string',
    );
    const local = scopes.acquire(cb)?.variables.find((v) => v.identifiers.includes(item.id));
    check(local && !local.references.some((r) => r.isWrite() && !r.init));
    for (const stmt of body.slice(1)) {
      const call = stmt.expression;
      check(
        stmt.type === 'ExpressionStatement' &&
          call?.type === 'CallExpression' &&
          call.callee?.type === 'MemberExpression' &&
          !call.callee.computed &&
          call.callee.property.name === 'equal' &&
          refs.get(call.callee.object) === assertion &&
          call.arguments.length === 2 &&
          call.arguments[1].type === 'Literal',
      );
      const run = call.arguments[0];
      check(
        run?.type === 'CallExpression' &&
          refs.get(run.callee) === vars.get('run') &&
          run.arguments.length === 2 &&
          run.arguments[0].type === 'Literal' &&
          typeof run.arguments[0].value === 'string' &&
          refs.get(run.arguments[1]) === local,
      );
    }
    return {
      ...empty(),
      fixtures: [
        {
          baselineId: row.id,
          clockSha256: hash(vars.get('NOW').defs[0].node.init),
          hostSha256: hash(vars.get('hostOf').defs[0].node.init),
          runnerSha256: hash(vars.get('run').defs[0].node.init),
          selectedBodySha256: hash(cb.body),
        },
      ],
      requiresAllRegistrations: true,
    };
  } catch {
    return empty();
  }
}
