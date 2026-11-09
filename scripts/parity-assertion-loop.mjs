// Bounded authored-input certificate for literal, typed assertion loops.
// This certifies neither the implementation under test nor native behavior by itself.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { hashAst as hash } from './parity-ast-utils.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const fail = () => {
  throw Object.assign(new Error('unsupported-assertion-loop'), { qualificationCode: 'unsupported-assertion-loop' });
};
const check = (value) => {
  if (!value) fail();
};
const jsonHash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function declaration(ast, name) {
  const found = ast.body.filter(
    (n) =>
      n.type === 'VariableDeclaration' &&
      n.kind === 'const' &&
      n.declarations.length === 1 &&
      n.declarations[0].id?.name === name,
  );
  check(found.length === 1);
  return found[0];
}
function encodedNumber(value) {
  if (Object.is(value, -0)) return '-0';
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return String(value);
}
function encoded(value, seen = new Set()) {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  if (typeof value === 'number') return ['number', encodedNumber(value)];
  check(typeof value === 'object' && !seen.has(value));
  seen.add(value);
  return encodeComposite(value, seen);
}
function encodeComposite(value, seen) {
  let out;
  if (Array.isArray(value)) {
    check(Object.getPrototypeOf(value) === Array.prototype);
    const keys = Reflect.ownKeys(value),
      length = Object.getOwnPropertyDescriptor(value, 'length');
    check(
      keys.length === value.length + 1 &&
        keys.at(-1) === 'length' &&
        length &&
        Object.hasOwn(length, 'value') &&
        length.writable &&
        !length.enumerable &&
        !length.configurable,
    );
    out = [
      'array',
      Array.from({ length: value.length }, (_, i) => {
        check(keys[i] === String(i));
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        check(d && Object.hasOwn(d, 'value') && d.enumerable && d.configurable && d.writable);
        return encoded(d.value, seen);
      }),
    ];
  } else if (Object.getPrototypeOf(value) === Map.prototype) {
    check(Reflect.ownKeys(value).length === 0);
    out = ['map', Array.from(Map.prototype.entries.call(value), ([k, v]) => [encoded(k, seen), encoded(v, seen)])];
  } else {
    check(Object.getPrototypeOf(value) === Object.prototype);
    out = [
      'object',
      Reflect.ownKeys(value).map((k) => {
        check(typeof k === 'string');
        const d = Object.getOwnPropertyDescriptor(value, k);
        check(d && Object.hasOwn(d, 'value') && d.enumerable && d.configurable && d.writable);
        return [k, encoded(d.value, seen)];
      }),
    ];
  }
  seen.delete(value);
  return out;
}

function sidecar(value) {
  if (Array.isArray(value)) return value.map(sidecar);
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) === Map.prototype)
      return { $map: Array.from(value, ([k, v]) => [sidecar(k), sidecar(v)]) };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sidecar(v)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  check(value !== undefined && !Object.is(value, -0));
  return value;
}
function evaluate(ast, node, dependencies, locals = new Map()) {
  if (node?.type === 'Literal') {
    check(node.regex === undefined && ['string', 'boolean', 'number', 'object'].includes(typeof node.value));
    return node.value;
  }
  if (
    node?.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument?.type === 'Literal' &&
    typeof node.argument.value === 'number'
  )
    return -node.argument.value;
  if (node?.type === 'Identifier') return evaluateIdentifier(ast, node, dependencies, locals);
  if (node?.type === 'ArrayExpression') return evaluateArray(ast, node, dependencies, locals);
  if (node?.type === 'ObjectExpression') return evaluateObject(ast, node, dependencies, locals);
  if (node?.type === 'NewExpression' && node.callee?.name === 'Map')
    return evaluateMap(ast, node, dependencies, locals);
  if (node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.arguments.length === 1)
    return evaluateCall(ast, node, dependencies, locals);
  fail();
}
function evaluateCall(ast, node, dependencies, locals) {
  const d = declaration(ast, node.callee.name),
    fn = d.declarations[0].init;
  check(
    fn?.type === 'ArrowFunctionExpression' &&
      !fn.async &&
      fn.params.length === 1 &&
      fn.params[0].type === 'Identifier' &&
      fn.body.type === 'ObjectExpression',
  );
  const p = fn.body.properties;
  check(
    p.length === 2 &&
      p[0].key?.name === 'type' &&
      p[0].value?.type === 'Literal' &&
      p[0].value.value === 'string' &&
      p[1].key?.name === 'value' &&
      p[1].value?.name === fn.params[0].name,
  );
  dependencies.set(node.callee.name, d);
  const local = new Map(locals);
  local.set(fn.params[0].name, evaluate(ast, node.arguments[0], dependencies, locals));
  return evaluate(ast, fn.body, dependencies, local);
}
function evaluateIdentifier(ast, node, dependencies, locals) {
  if (locals.has(node.name)) return locals.get(node.name);
  if (node.name === 'Infinity') return Infinity;
  const d = declaration(ast, node.name);
  dependencies.set(node.name, d);
  const n = d.declarations[0].init;
  check(n?.type === 'Literal' && typeof n.value === 'string');
  return n.value;
}
function evaluateMap(ast, node, dependencies, locals) {
  check(node.arguments.length <= 1);
  const entries = node.arguments.length ? evaluate(ast, node.arguments[0], dependencies, locals) : [];
  check(Array.isArray(entries) && entries.every((x) => Array.isArray(x) && x.length === 2));
  const map = new Map(entries);
  check(map.size === entries.length);
  return map;
}
function evaluateObject(ast, node, dependencies, locals) {
  const pairs = node.properties.map((p) => {
    check(
      p.type === 'Property' &&
        p.kind === 'init' &&
        !p.computed &&
        !p.method &&
        p.key?.type === 'Identifier' &&
        !['__proto__', 'constructor', 'prototype'].includes(p.key.name),
    );
    return [p.key.name, evaluate(ast, p.value, dependencies, locals)];
  });
  check(new Set(pairs.map((p) => p[0])).size === pairs.length);
  return Object.fromEntries(pairs);
}
function evaluateArray(ast, node, dependencies, locals) {
  const result = [];
  for (const x of node.elements) {
    check(x);
    if (x.type === 'SpreadElement') {
      const call = x.argument,
        member = call?.callee,
        arrow = call?.arguments?.[0];
      check(
        call?.type === 'CallExpression' &&
          call.arguments.length === 1 &&
          member?.type === 'MemberExpression' &&
          !member.computed &&
          member.property.name === 'map' &&
          member.object?.type === 'ArrayExpression' &&
          arrow?.type === 'ArrowFunctionExpression' &&
          !arrow.async &&
          arrow.params.length === 1 &&
          arrow.params[0].type === 'Identifier' &&
          arrow.body.type === 'ObjectExpression',
      );
      const source = evaluate(ast, member.object, dependencies, locals);
      for (const item of source) {
        const inner = new Map(locals);
        inner.set(arrow.params[0].name, item);
        result.push(evaluate(ast, arrow.body, dependencies, inner));
      }
    } else result.push(evaluate(ast, x, dependencies, locals));
  }
  return result;
}
function pointer(o, path) {
  check(typeof path === 'string' && path.startsWith('/'));
  return path
    .slice(1)
    .split('/')
    .reduce((v, k) => {
      k = k.replaceAll('~1', '/').replaceAll('~0', '~');
      check(v !== null && typeof v === 'object' && Object.hasOwn(v, k));
      return v[k];
    }, o);
}
/** Caller must pin full module, registrations, source and evidence at qualification and runtime. */
export function analyzeAssertionLoop({ baselineAst, currentAst, selected, selection, proof, capsule }) {
  const before = selected?.old?.callback,
    after = selected?.current?.callback;
  check(
    before?.type === 'ArrowFunctionExpression' &&
      !before.async &&
      before.params.length === 0 &&
      before.body?.type === 'BlockStatement' &&
      after &&
      hash(before.body) === hash(after.body),
  );
  const exactCallback = parse(
    "test('x', () => { for (const value of VALUES) { const xml = envelope(encodeValue('v', value)); assert.deepStrictEqual(decodeFrom(xml), value, `direct ${value.type}`); assert.deepStrictEqual(decodeFrom(renamed(xml)), value, `renamed ${value.type}`); } assert.equal(decodeFrom(envelope(encodeValue('v', null))), null); assert.deepStrictEqual(decodeFrom(envelope(encodeValue('v', 'plain'))), text('plain')); });",
    { ecmaVersion: 'latest', sourceType: 'module', range: true },
  ).body[0].expression.arguments[1];
  check(hash(before.body) === hash(exactCallback.body));
  const assertImports = baselineAst.body.filter(
    (n) =>
      n.type === 'ImportDeclaration' &&
      n.source.value === 'node:assert/strict' &&
      n.specifiers.some((s) => s.type === 'ImportDefaultSpecifier' && s.local.name === 'assert'),
  );
  check(assertImports.length === 1);
  for (const name of ['Map', 'Infinity'])
    check(
      !baselineAst.body.some(
        (n) =>
          (n.type === 'VariableDeclaration' && n.declarations.some((d) => d.id?.name === name)) ||
          (n.type === 'FunctionDeclaration' && n.id?.name === name) ||
          (n.type === 'ImportDeclaration' && n.specifiers.some((s) => s.local?.name === name)),
      ),
    );
  const statements = before.body.body,
    loop = statements[0];
  check(
    statements.length === 3 &&
      loop?.type === 'ForOfStatement' &&
      loop.left?.type === 'VariableDeclaration' &&
      loop.left.kind === 'const' &&
      loop.left.declarations.length === 1 &&
      loop.left.declarations[0].id?.type === 'Identifier' &&
      loop.right?.type === 'Identifier' &&
      loop.body?.type === 'BlockStatement' &&
      loop.body.body.length === 3,
  );
  const sourceName = loop.right.name,
    decl = declaration(baselineAst, sourceName),
    currentDecl = declaration(currentAst, sourceName);
  check(hash(decl) === hash(currentDecl) && decl.declarations[0].init?.type === 'ArrayExpression');
  const deps = new Map([[sourceName, decl]]),
    values = evaluate(baselineAst, decl.declarations[0].init, deps);
  check(values.length === 27);
  const [setup, ...assertions] = loop.body.body;
  check(
    setup.type === 'VariableDeclaration' &&
      setup.kind === 'const' &&
      setup.declarations.length === 1 &&
      setup.declarations[0].id.type === 'Identifier' &&
      assertions.length === 2 &&
      assertions.every(
        (n) =>
          n.type === 'ExpressionStatement' &&
          n.expression?.type === 'CallExpression' &&
          n.expression.callee?.type === 'MemberExpression' &&
          n.expression.callee.object?.name === 'assert' &&
          n.expression.callee.property?.name === 'deepStrictEqual',
      ) &&
      statements.slice(1).every((n) => n.type === 'ExpressionStatement' && n.expression?.type === 'CallExpression'),
  );
  const helperSource = {
    renamed: String.raw`const renamed = (xml) => xml.replace(/xmlns:([a-z0-9]+)=/g, 'xmlns:p$1=').replace(/(?<=[<\s"/])(?!xmlns:|xml:|https?:)([a-z0-9]+)(?=:)/g, 'p$1');`,
    decodeFrom: 'const decodeFrom = (xml) => decodeValue(parseEnvelope(xml).request);',
  };
  for (const name of ['renamed', 'decodeFrom']) {
    const d = declaration(baselineAst, name),
      n = declaration(currentAst, name),
      expected = parse(helperSource[name], { ecmaVersion: 'latest', sourceType: 'module', range: true }).body[0];
    check(hash(d) === hash(n) && hash(d) === hash(expected));
    deps.set(name, d);
  }
  check(
    selection?.sourceBinding === sourceName &&
      selection.originalLoopRows === 27 &&
      Array.isArray(selection.instanceBindings) &&
      selection.preserveUnselectedExecution === true &&
      selection.preserveAssertionSites === true,
  );
  check(
    Array.isArray(capsule?.cases) &&
      capsule.cases.length === 29 &&
      Array.isArray(capsule.runs) &&
      capsule.runs.length === 2 &&
      capsule.runs.every(
        (r) => Number.isInteger(r.processId) && r.processId > 0 && /^[a-f0-9]{64}$/.test(r.rawSha256),
      ) &&
      capsule.runs[0].processId !== capsule.runs[1].processId &&
      !same(capsule.runs[0].rawSha256, capsule.runs[1].rawSha256),
  );
  check(same(proof.capturePointers, ['/runs/0/rawSha256', '/runs/1/rawSha256']));
  const verifyAllRecordedCases = () => {
    for (let i = 0; i < 27; i++) {
      const c = capsule.cases[i];
      check(
        c.id === i &&
          same(sidecar(values[i]), c.expected) &&
          typeof c.xmlDirect === 'string' &&
          c.xmlRenamed ===
            c.xmlDirect
              .replace(/xmlns:([a-z0-9]+)=/g, 'xmlns:p$1=')
              .replace(/(?<=[<\s"/])(?!xmlns:|xml:|https?:)([a-z0-9]+)(?=:)/g, 'p$1'),
      );
    }
  };
  verifyAllRecordedCases();
  check(
    capsule.cases[27].id === 'null' &&
      capsule.cases[27].expected === null &&
      capsule.cases[28].id === 'plain' &&
      same(capsule.cases[28].expected, { type: 'string', value: 'plain' }),
  );
  const selectedIndices = selection.selectedValueIndices,
    held = selection.heldValueIndices;
  check(
    Array.isArray(selectedIndices) &&
      Array.isArray(held) &&
      selectedIndices.length + held.length === 27 &&
      same(
        [...selectedIndices, ...held].sort((a, b) => a - b),
        Array.from({ length: 27 }, (_, i) => i),
      ) &&
      same(
        [...selectedIndices].sort((a, b) => a - b),
        selectedIndices,
      ),
  );
  const assertionsHash = assertions.map((n) => hash(n.expression)),
    tailHash = statements.slice(1).map((n) => hash(n.expression)),
    facts = new Map(proof.facts.map((f) => [f.id, f]));
  check(facts.size === proof.facts.length);
  const expected = [];
  const verifySelectedCases = () => {
    for (const i of selectedIndices)
      for (let j = 0; j < 2; j++)
        expected.push({
          originalValueIndex: i,
          caseIndex: i,
          variant: j ? 'renamed' : 'direct',
          assertionAstSha256: assertionsHash[j],
        });
  };
  verifySelectedCases();
  expected.push(
    { originalValueIndex: null, caseIndex: 27, variant: 'direct', assertionAstSha256: tailHash[0] },
    { originalValueIndex: null, caseIndex: 28, variant: 'direct', assertionAstSha256: tailHash[1] },
  );
  check(expected.length === selection.instanceBindings.length && facts.size === expected.length);
  check(
    same(capsule.heldIds, held) &&
      Array.isArray(capsule.selectedAssertions) &&
      capsule.selectedAssertions.length === expected.length &&
      expected.every((e, i) => Object.keys(e).every((k) => capsule.selectedAssertions[i][k] === e[k])),
  );
  const used = new Set();
  const verifySelectedFacts = () => {
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i],
        b = selection.instanceBindings[i];
      check(
        Object.keys(e).every((k) => e[k] === b[k]) &&
          Array.isArray(b.factIds) &&
          b.factIds.length === 1 &&
          !used.has(b.factIds[0]),
      );
      used.add(b.factIds[0]);
      const f = facts.get(b.factIds[0]),
        p = `/runs/0/results/${e.caseIndex}/${e.variant}`;
      check(
        f?.pointer === p &&
          same(f.replicatedPointers, [p, `/runs/1/results/${e.caseIndex}/${e.variant}`]) &&
          capsule.runs.every((r) => r.results[e.caseIndex].id === capsule.cases[e.caseIndex].id),
      );
      const a = pointer(capsule, p),
        z = pointer(capsule, f.replicatedPointers[1]);
      check(
        jsonHash(a) === f.sha256 &&
          jsonHash(z) === f.sha256 &&
          a.phase === 'value' &&
          same(a.canonical, capsule.cases[e.caseIndex].expected),
      );
    }
  };
  verifySelectedFacts();
  const descriptor = {
    version: 1,
    sourceBinding: sourceName,
    loopAstSha256: hash(loop),
    callbackAstSha256: hash(before.body),
    dependencies: [...deps].map(([name, node]) => ({ name, astSha256: hash(node) })),
    universe: values.map((v) => encoded(v)),
    xml: values.map((_, i) => capsule.cases[i].xmlDirect),
    tailXml: capsule.cases.slice(27).map((c) => c.xmlDirect),
    selectedIndices,
    heldIndices: held,
    assertionAstSha256: assertionsHash,
    tailAstSha256: tailHash,
    instances: selection.instanceBindings,
  };
  return { descriptor, loopNode: loop, assertionNodes: assertions, tailNodes: statements.slice(1) };
}
/** Check all values, their position and the original encoded input before an iteration's assertions. */
export function assertAssertionLoopValue(values, index, value, xml, descriptor) {
  check(
    descriptor?.version === 1 &&
      Array.isArray(descriptor.universe) &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < descriptor.universe.length &&
      Array.isArray(values) &&
      values.length === descriptor.universe.length &&
      same(encoded(values), ['array', descriptor.universe]) &&
      value === values[index] &&
      xml === descriptor.xml[index],
  );
}
export function assertAssertionLoopCompletion(count, descriptor) {
  check(descriptor?.version === 1 && Array.isArray(descriptor.universe) && count === descriptor.universe.length);
}
/** Return the existing tail XML unchanged after binding it to its reproduced input. */
export function assertAssertionTailXml(xml, index, descriptor) {
  check(
    descriptor?.version === 1 &&
      (index === 0 || index === 1) &&
      typeof xml === 'string' &&
      xml === descriptor.tailXml[index],
  );
  return xml;
}
