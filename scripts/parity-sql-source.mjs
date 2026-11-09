// Source-only SQL matrix extraction. It does not execute source or grant parity credit.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const normalize = (v) =>
  typeof v === 'bigint'
    ? { $bigint: String(v) }
    : Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !['loc', 'range', 'start', 'end', 'raw'].includes(k))
              .map(([k, x]) => [k, normalize(x)]),
          )
        : v;
const parityAstHash = (node) =>
  createHash('sha256')
    .update(JSON.stringify(normalize(node)))
    .digest('hex');
const require = createRequire(import.meta.url);
const { parse } = require('espree');
const { analyze } = require('eslint-scope');
const sha = (x) => createHash('sha256').update(x).digest('hex');
const parseModule = (s) => parse(s, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
const fail = (reason) => {
  throw Object.assign(new Error(reason), { qualificationCode: reason });
};
const expectedHelper = {
  utc: 'const utc = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));',
  dec: 'const dec = (decimal) => ({ decimal });',
};
const helperHash = Object.fromEntries(
  Object.entries(expectedHelper).map(([name, source]) => [
    name,
    parityAstHash(parseModule(source).body[0].declarations[0].init),
  ]),
);
export function extract(source) {
  const ast = parseModule(source),
    decls = ast.body
      .filter((x) => x.type === 'VariableDeclaration' && x.kind === 'const')
      .flatMap((x) => x.declarations);
  for (const [name, hash] of Object.entries(helperHash)) {
    const found = decls.filter((x) => x.id.type === 'Identifier' && x.id.name === name);
    if (found.length !== 1 || parityAstHash(found[0].init) !== hash) fail('unsafe-helper:' + name);
  }
  const scope = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' }).scopes.find((x) => x.type === 'module');
  const parents = new Map();
  function indexParents(n, parent = null) {
    if (!n || !n.type) return;
    parents.set(n, parent);
    for (const v of Object.values(n))
      if (Array.isArray(v)) v.forEach((x) => indexParents(x, n));
      else if (v && typeof v === 'object' && v.type) indexParents(v, n);
  }
  indexParents(ast);
  for (const name of ['utc', 'dec']) {
    const variable = scope?.set.get(name);
    if (
      !variable ||
      variable.defs.length !== 1 ||
      variable.references.some(
        (r) =>
          (r.isWrite() && !r.init) ||
          (!r.init &&
            (parents.get(r.identifier)?.type !== 'CallExpression' ||
              parents.get(r.identifier).callee !== r.identifier)),
      )
    )
      fail('mutated-helper:' + name);
  }
  const candidates = decls.filter((x) => x.id.type === 'Identifier' && x.id.name === 'cases');
  if (candidates.length !== 1 || candidates[0].init?.type !== 'ArrayExpression') fail('unsafe-case-array');
  const loops = ast.body.filter(
    (x) => x.type === 'ForOfStatement' && x.right.type === 'Identifier' && x.right.name === 'cases',
  );
  if (loops.length !== 1) fail('ambiguous-registration-loop');
  const target = loops[0],
    knownLoop = '33d947fec013df81410ebe0bbafff650ea284a545450eddbaaf0d0f558146762';
  if (parityAstHash(target) !== knownLoop) fail('unsupported-registration-shape');
  const testImports = ast.body.filter((x) => x.type === 'ImportDeclaration' && x.source.value === 'node:test');
  if (
    testImports.length !== 1 ||
    testImports[0].specifiers.length !== 1 ||
    testImports[0].specifiers[0].type !== 'ImportDefaultSpecifier' ||
    testImports[0].specifiers[0].local.name !== 'test'
  )
    fail('unsafe-test-binding');
  if (['Date', 'Math', 'JSON', 'Number'].some((name) => scope.set.has(name))) fail('shadowed-intrinsic');
  const testVar = scope.set.get('test');
  if (
    !testVar ||
    testVar.defs.length !== 1 ||
    testVar.references.some(
      (r) =>
        (r.isWrite() && !r.init) ||
        parents.get(r.identifier)?.type !== 'CallExpression' ||
        parents.get(r.identifier).callee !== r.identifier,
    )
  )
    fail('unsafe-test-binding');
  function validateRegistrationCall(n) {
    const c = n.callee,
      inTarget = n.range[0] >= target.range[0] && n.range[1] <= target.range[1];
    const simple = c.type === 'Identifier' && ['test', 'utc', 'dec'].includes(c.name);
    const json =
      c.type === 'MemberExpression' && !c.computed && c.object.name === 'JSON' && c.property.name === 'stringify';
    const literal =
      c.type === 'MemberExpression' &&
      !c.computed &&
      c.object.type === 'Literal' &&
      typeof c.object.value === 'string' &&
      ['repeat', 'padEnd'].includes(c.property.name) &&
      n.arguments.length === 1 &&
      n.arguments[0].type === 'Literal' &&
      Number.isSafeInteger(n.arguments[0].value) &&
      n.arguments[0].value >= 0 &&
      n.arguments[0].value <= 1000;
    const pinnedTitle =
      inTarget && c.type === 'MemberExpression' && !c.computed && ['map', 'join'].includes(c.property.name);
    if (!(simple || json || literal || pinnedTitle)) fail('unsafe-registration-call');
    if (
      c.type === 'Identifier' &&
      c.name === 'test' &&
      (n.arguments.length !== 2 || !['ArrowFunctionExpression', 'FunctionExpression'].includes(n.arguments[1]?.type))
    )
      fail('unsafe-test-call');
  }
  function validateRegistrationProperty(n) {
    if (
      n.type === 'Property' &&
      (n.kind !== 'init' ||
        n.method ||
        n.computed ||
        ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(n.key.name ?? n.key.value))
    )
      fail('unsafe-registration-property');
    if (
      n.type === 'MemberExpression' &&
      ['__proto__', 'constructor', 'prototype'].includes(n.computed ? n.property.value : n.property.name)
    )
      fail('unsafe-registration-property');
  }
  function scan(n) {
    if (!n || !n.type) return;
    if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(n.type)) return;
    if (
      [
        'AssignmentExpression',
        'UpdateExpression',
        'AwaitExpression',
        'YieldExpression',
        'ImportExpression',
        'NewExpression',
        'WhileStatement',
        'DoWhileStatement',
        'ForStatement',
        'ForInStatement',
        'TryStatement',
        'ThrowStatement',
      ].includes(n.type)
    )
      fail('unsafe-registration-effect:' + n.type);
    if (n.type === 'VariableDeclaration' && n.kind !== 'const') fail('unsafe-registration-binding');
    validateRegistrationProperty(n);
    if (n.type === 'CallExpression') validateRegistrationCall(n);
    for (const v of Object.values(n))
      if (Array.isArray(v)) v.forEach((x) => scan(x, n));
      else if (v && typeof v === 'object' && v.type) scan(v, n);
  }
  scan(ast);
  let refs = 0;
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Identifier' && n.name === 'cases') refs++;
    for (const v of Object.values(n))
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
  }
  walk(ast);
  if (refs !== 2) fail('shared-or-mutated-case-array');
  function objectValue(n) {
    const out = {};
    for (const p of n.properties) {
      if (p.type !== 'Property' || p.computed || p.method || p.shorthand || p.kind !== 'init') fail('unsafe-object');
      const key = p.key.name ?? p.key.value;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(out, key))
        fail('unsafe-object-key');
      out[key] = value(p.value);
    }
    return { type: 'object', value: out };
  }
  function unaryValue(n) {
    const v = value(n.argument);
    if (v.type === 'number') return { type: 'number', value: n.operator === '-' ? -v.value : +v.value };
    if (v.type === 'bigint' && n.operator === '-') return { type: 'bigint', value: '-' + v.value };
    fail('unsupported-expression:' + n.type);
  }
  function callValue(n) {
    if (n.callee.type === 'Identifier' && n.callee.name === 'dec' && n.arguments.length === 1) {
      const v = value(n.arguments[0]);
      if (v.type !== 'string') fail('unsafe-decimal');
      return { type: 'object', value: { decimal: v } };
    }
    if (
      n.callee.type === 'Identifier' &&
      n.callee.name === 'utc' &&
      n.arguments.length >= 3 &&
      n.arguments.length <= 7
    ) {
      const parts = n.arguments.map(value);
      if (parts.some((v) => v.type !== 'number' || !Number.isSafeInteger(v.value))) fail('unsafe-date');
      const [y, mo, d, h = 0, mi = 0, sec = 0, ms = 0] = parts.map((x) => x.value);
      const date = new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms));
      if (!Number.isFinite(date.valueOf())) fail('invalid-date');
      return { type: 'date', value: date.toISOString() };
    }
    if (
      n.callee.type === 'MemberExpression' &&
      !n.callee.computed &&
      n.callee.property.name === 'repeat' &&
      n.arguments.length === 1
    ) {
      const base = value(n.callee.object),
        count = value(n.arguments[0]);
      if (
        base.type !== 'string' ||
        count.type !== 'number' ||
        !Number.isSafeInteger(count.value) ||
        count.value < 0 ||
        count.value > 1000 ||
        base.value.length * count.value > 4096
      )
        fail('unsafe-repeat');
      return { type: 'string', value: base.value.repeat(count.value) };
    }
    fail('unsupported-expression:' + n.type);
  }
  function literalValue(n) {
    if (n.bigint !== undefined) return { type: 'bigint', value: n.bigint };
    if (n.value === null) return { type: 'null' };
    if (
      ['string', 'number', 'boolean'].includes(typeof n.value) &&
      !(typeof n.value === 'number' && !Number.isFinite(n.value))
    )
      return { type: typeof n.value, value: n.value };
    fail('unsupported-expression:' + n.type);
  }
  function value(n) {
    if (!n) fail('missing-expression');
    if (n.type === 'Literal') return literalValue(n);
    if (n.type === 'ArrayExpression') return { type: 'array', value: n.elements.map(value) };
    if (n.type === 'ObjectExpression') return objectValue(n);
    if (n.type === 'UnaryExpression' && ['-', '+'].includes(n.operator)) return unaryValue(n);
    if (n.type === 'MemberExpression' && !n.computed && n.object.name === 'Math' && n.property.name === 'PI')
      return { type: 'number', value: Math.PI };
    if (n.type === 'CallExpression') return callValue(n);
    fail('unsupported-expression:' + n.type);
  }
  const rows = candidates[0].init.elements.map(value);
  if (rows.some((x) => x.type !== 'array' || x.value.length < 3 || x.value.length > 4)) fail('invalid-row');
  // Only the exact reviewed title/callback skeleton may use this formatter.
  const loopHash = parityAstHash(loops[0]);
  let titles = null;
  if (loopHash === knownLoop) {
    function materialize(v) {
      switch (v.type) {
        case 'null':
          return null;
        case 'string':
        case 'number':
        case 'boolean':
          return v.value;
        case 'bigint':
          return BigInt(v.value);
        case 'date':
          return new Date(v.value);
        case 'array':
          return v.value.map(materialize);
        case 'object':
          return Object.fromEntries(Object.entries(v.value).map(([k, x]) => [k, materialize(x)]));
        default:
          fail('unsupported-title-value');
      }
    }
    titles = rows.map(({ value: items }) => {
      const [name, args, , ctx] = items.map(materialize);
      if (typeof name !== 'string' || !Array.isArray(args)) fail('unsafe-title');
      return `${name}(${args.map((a) => (a instanceof Date ? a.toISOString() : typeof a === 'bigint' ? `${a}n` : JSON.stringify(a))).join(', ')})${ctx ? ` ${JSON.stringify(ctx)}` : ''}`;
    });
  }
  return {
    sourceSha256: sha(source),
    caseArrayAstSha256: parityAstHash(candidates[0].init),
    loopAstSha256: loopHash,
    helperHash,
    rowAstSha256: candidates[0].init.elements.map(parityAstHash),
    titles,
    rows,
  };
}
