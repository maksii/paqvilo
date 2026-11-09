// Infer a deliberately small, source-owned temporary-file producer family.
// This is input provenance, not evidence of platform behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { parse } = createRequire(import.meta.url)('espree');
const { analyze: analyzeScopes } = createRequire(import.meta.url)('eslint-scope');
const parseModule = (text) => parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
const digest = (data) => createHash('sha256').update(data).digest('hex');
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['loc', 'range', 'start', 'end', 'raw'].includes(key))
      .map(([key, item]) => [key, clean(item)]),
  );
}
const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));
const fail = () => {
  throw Object.assign(new Error('unsupported-generated-fixture'), {
    qualificationCode: 'unsupported-generated-fixture',
  });
};
const requireProof = (value) => {
  if (!value) fail();
};
const children = (node) =>
  Object.values(node).flatMap((v) => {
    if (Array.isArray(v)) return v.filter((x) => x?.type);
    return v?.type ? [v] : [];
  });
function walk(node, fn, parent = null) {
  fn(node, parent);
  for (const child of children(node)) walk(child, fn, node);
}
function bindingNames(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'RestElement') return bindingNames(node.argument);
  if (node.type === 'AssignmentPattern') return bindingNames(node.left);
  if (node.type === 'ArrayPattern') return node.elements.flatMap(bindingNames);
  if (node.type === 'ObjectPattern')
    return node.properties.flatMap((item) => bindingNames(item.type === 'RestElement' ? item.argument : item.value));
  return fail();
}
const identifier = (node) =>
  node?.type === 'Identifier' && /^[A-Za-z_$][\w$]*$/u.test(node.name) ? node.name : fail();
const importBinding = (ast, source, imported) => {
  const declarations = ast.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === source);
  requireProof(declarations.length === 1 && declarations[0].specifiers.length === 1);
  const specifier = declarations[0].specifiers[0];
  requireProof(
    imported === 'default'
      ? specifier.type === 'ImportDefaultSpecifier'
      : specifier.type === 'ImportSpecifier' && specifier.imported.name === imported,
  );
  return { name: identifier(specifier.local), declaration: declarations[0] };
};
function safeName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !/[\\:<>"|?*]/u.test(name) &&
    ![...name].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) > 126) &&
    !name.startsWith('/') &&
    name
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          part !== '__proto__' &&
          !/[. ]$/u.test(part) &&
          !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  );
}

function constant(variable) {
  const definition = variable.defs[0];
  requireProof(definition.type === 'Variable' && definition.parent?.kind === 'const' && definition.node.init);
  return definition.node.init;
}

/** Enumerate statically constructed map keys; this alone does not certify values or module effects. */
export function inferStaticObjectKeys({ ast, expression }) {
  let scopes;
  try {
    scopes = analyzeScopes(ast, { ecmaVersion: 2022, sourceType: 'module' });
  } catch {
    fail();
  }
  const references = new Map();
  for (const scope of scopes.scopes)
    for (const reference of scope.references) references.set(reference.identifier, reference.resolved);
  const active = new Set();
  function binding(node) {
    const variable = references.get(node);
    requireProof(variable?.defs.length === 1 && !variable.references.some((ref) => ref.isWrite() && !ref.init));
    return variable;
  }
  function textValue(node, environment) {
    if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node?.type === 'Identifier') {
      const variable = binding(node);
      if (environment.has(variable)) {
        const value = environment.get(variable);
        requireProof(typeof value === 'string');
        return value;
      }
      requireProof(!active.has(variable));
      active.add(variable);
      try {
        return textValue(constant(variable), environment);
      } finally {
        active.delete(variable);
      }
    }
    if (node?.type === 'TemplateLiteral') {
      let result = node.quasis[0].value.cooked;
      requireProof(typeof result === 'string');
      for (let i = 0; i < node.expressions.length; i++) {
        const suffix = node.quasis[i + 1].value.cooked;
        requireProof(typeof suffix === 'string');
        result += textValue(node.expressions[i], environment) + suffix;
      }
      return result;
    }
    return fail();
  }
  function keysCall(node, environment) {
    const variable = binding(node.callee),
      fn = constant(variable);
    requireProof(
      fn.type === 'ArrowFunctionExpression' &&
        fn.expression &&
        !fn.async &&
        !fn.generator &&
        fn.params.every(
          (param) =>
            param.type === 'Identifier' || (param.type === 'AssignmentPattern' && param.left.type === 'Identifier'),
        ),
    );
    const scope = scopes.acquire(fn),
      nested = new Map(environment);
    requireProof(scope);
    for (let i = 0; i < fn.params.length; i++) {
      const pattern = fn.params[i],
        name = pattern.type === 'Identifier' ? pattern.name : pattern.left.name;
      const param = scope.variables.find((item) => item.name === name);
      requireProof(param && !param.references.some((ref) => ref.isWrite() && !ref.init));
      const argument = node.arguments[i] ?? (pattern.type === 'AssignmentPattern' ? pattern.right : null);
      let value = null;
      try {
        value = textValue(argument, environment);
      } catch {
        /* Unknown values may not contribute to a key. */
      }
      nested.set(param, value);
    }
    requireProof(!active.has(variable));
    active.add(variable);
    try {
      return keys(fn.body, nested);
    } finally {
      active.delete(variable);
    }
  }
  function keys(node, environment) {
    if (node?.type === 'Identifier') {
      const variable = binding(node);
      requireProof(!active.has(variable));
      active.add(variable);
      try {
        return keys(constant(variable), environment);
      } finally {
        active.delete(variable);
      }
    }
    if (
      node?.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      !node.optional &&
      node.arguments.every((arg) => arg.type !== 'SpreadElement')
    ) {
      return keysCall(node, environment);
    }
    requireProof(node?.type === 'ObjectExpression');
    const result = [];
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        result.push(...keys(property.argument, environment));
        continue;
      }
      requireProof(property.type === 'Property' && property.kind === 'init' && !property.method);
      let name;
      if (property.computed) name = textValue(property.key, environment);
      else if (property.key.type === 'Identifier') name = property.key.name;
      else name = property.key.value;
      requireProof(safeName(name));
      result.push(name);
    }
    return result;
  }
  const names = keys(expression, new Map()),
    folded = new Map();
  for (const name of names) {
    const lower = name.toLowerCase();
    requireProof(!folded.has(lower) || folded.get(lower) === name);
    folded.set(lower, name);
  }
  for (const name of folded.keys())
    for (const other of folded.keys()) requireProof(name === other || !other.startsWith(name + '/'));
  return [...new Set(names)];
}

/** Prove the eager non-import module bootstrap is static. Test callbacks are not executed here. */
export function assertPureFixtureBootstrap({ ast }) {
  let manager;
  try {
    manager = analyzeScopes(ast, { ecmaVersion: 2022, sourceType: 'module' });
  } catch {
    fail();
  }
  const refs = new Map();
  for (const scope of manager.scopes) for (const ref of scope.references) refs.set(ref.identifier, ref.resolved);
  const active = new Set();
  function pureObject(node) {
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement') {
        pure(prop.argument);
        continue;
      }
      requireProof(prop.type === 'Property' && prop.kind === 'init' && !prop.method);
      if (prop.computed) pure(prop.key);
      pure(prop.value);
    }
  }
  function pureLocalCall(node) {
    const variable = refs.get(node.callee),
      def = variable?.defs?.[0];
    requireProof(
      variable?.defs.length === 1 &&
        def?.type === 'Variable' &&
        def.parent?.kind === 'const' &&
        def.node.init?.type === 'ArrowFunctionExpression' &&
        !variable.references.some((ref) => ref.isWrite() && !ref.init) &&
        !active.has(variable),
    );
    node.arguments.forEach(pure);
    active.add(variable);
    try {
      pure(def.node.init);
    } finally {
      active.delete(variable);
    }
  }
  function pureDate(node) {
    const utc = node.arguments[0];
    requireProof(
      utc?.type === 'CallExpression' &&
        utc.callee?.type === 'MemberExpression' &&
        !utc.callee.computed &&
        utc.callee.object?.name === 'Date' &&
        !refs.get(utc.callee.object) &&
        utc.callee.property.name === 'UTC' &&
        utc.arguments.every((arg) => arg.type === 'Literal' && typeof arg.value === 'number'),
    );
  }
  function pureJoin(node) {
    requireProof(
      node.callee.object.elements.every((item) => item?.type === 'Literal' || item?.type === 'TemplateLiteral'),
    );
    pure(node.callee.object);
    node.arguments.forEach(pure);
  }
  function pure(node) {
    if (!node || node.type === 'Literal') return;
    if (node.type === 'Identifier') {
      const variable = refs.get(node);
      requireProof(variable?.defs.length === 1 && !variable.references.some((ref) => ref.isWrite() && !ref.init));
      const def = variable.defs[0];
      requireProof(def.type === 'Parameter' || (def.type === 'Variable' && def.parent?.kind === 'const'));
      return;
    }
    switch (node.type) {
      case 'TemplateLiteral':
        node.expressions.forEach(pure);
        return;
      case 'ArrayExpression':
        node.elements.forEach(pure);
        return;
    }
    if (node.type === 'ObjectExpression') return pureObject(node);
    if (node.type === 'ArrowFunctionExpression') {
      requireProof(
        node.expression && !node.async && !node.generator && node.params.every((param) => param.type === 'Identifier'),
      );
      pure(node.body);
      return;
    }
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.property.name === 'join' &&
      node.callee.object.type === 'ArrayExpression'
    ) {
      return pureJoin(node);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') return pureLocalCall(node);
    if (
      node.type === 'NewExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'Date' &&
      !refs.get(node.callee) &&
      node.arguments.length === 1
    ) {
      return pureDate(node);
    }
    fail();
  }
  const imports = ast.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === 'node:test');
  requireProof(
    imports.length === 1 &&
      imports[0].specifiers.length === 1 &&
      imports[0].specifiers[0].type === 'ImportDefaultSpecifier',
  );
  const testName = imports[0].specifiers[0].local.name,
    declarations = [];
  const verifyBootstrapStatements = () => {
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration' || node.type === 'FunctionDeclaration') continue;
      if (node.type === 'VariableDeclaration') {
        requireProof(node.kind === 'const');
        for (const declaration of node.declarations) {
          requireProof(declaration.id.type === 'Identifier' && declaration.init);
          pure(declaration.init);
        }
        declarations.push(digest(JSON.stringify(clean(node))));
        continue;
      }
      const call = node.type === 'ExpressionStatement' && node.expression;
      requireProof(
        call?.type === 'CallExpression' &&
          call.callee?.type === 'Identifier' &&
          call.callee.name === testName &&
          call.arguments.length === 2 &&
          call.arguments[0]?.type === 'Literal' &&
          ['FunctionExpression', 'ArrowFunctionExpression'].includes(call.arguments[1]?.type),
      );
    }
  };
  verifyBootstrapStatements();
  return { declarations };
}

const emptyFixtureSlice = () => ({
  recognizedIdentifiers: new Set(),
  recognizedBuiltinImports: new Set(),
  handledInputSources: new Set(),
  dependencies: [],
  fixtures: [],
  isolatedIdentifiers: new Set(),
});

/** Infer the source-only renderer slice and independent owned filesystem roots. */
export function analyzeUnselectedFixtureSlice({
  ast,
  selected,
  root,
  filePath,
  readBaseline,
  implementationSources = [],
}) {
  try {
    requireProof(selected.length === 1 && selected[0].old.callback.params.length === 0);
    const bootstrap = assertPureFixtureBootstrap({ ast }),
      row = selected[0].old;
    const scopes = analyzeScopes(ast, { ecmaVersion: 2022, sourceType: 'module' }),
      refs = new Map(),
      parents = new Map();
    for (const scope of scopes.scopes) for (const ref of scope.references) refs.set(ref.identifier, ref.resolved);
    walk(ast, (node, parent) => parents.set(node, parent));
    const moduleScope = scopes.scopes.find((scope) => scope.type === 'module');
    requireProof(moduleScope);
    const named = (name) => moduleScope.variables.find((item) => item.name === name);
    const fixed = (node) => {
      const variable = refs.get(node),
        def = variable?.defs?.[0];
      requireProof(
        variable?.defs.length === 1 &&
          def?.type === 'Variable' &&
          def.parent?.kind === 'const' &&
          !variable.references.some((ref) => ref.isWrite() && !ref.init),
      );
      return def.node.init;
    };
    const fsImport = importBinding(ast, 'node:fs/promises', 'default'),
      osImport = importBinding(ast, 'node:os', 'default'),
      pathImport = importBinding(ast, 'node:path', 'default');
    const testImport = importBinding(ast, 'node:test', 'default');
    const helperImports = ast.body.filter(
      (node) =>
        node.type === 'ImportDeclaration' &&
        node.specifiers.some(
          (part) => part.type === 'ImportSpecifier' && part.imported.name === 'makeTemporaryDirectory',
        ),
    );
    requireProof(helperImports.length === 1 && helperImports[0].specifiers.length === 1);
    const helperName = helperImports[0].specifiers[0].local.name,
      helperSource = helperImports[0].source.value;
    requireProof(typeof helperSource === 'string' && /^\.\.?\//u.test(helperSource) && !/[?#\\]/u.test(helperSource));
    const sutNames = new Set(
      ast.body
        .filter((node) => node.type === 'ImportDeclaration' && implementationSources.includes(node.source.value))
        .flatMap((node) => node.specifiers.map((part) => part.local.name)),
    );
    const sutBindings = new Set([...sutNames].map((name) => named(name)).filter(Boolean));
    const rendererDeclarations = row.callback.body.body.filter(
      (node) =>
        node.type === 'VariableDeclaration' &&
        node.kind === 'const' &&
        node.declarations.length === 1 &&
        node.declarations[0].id.type === 'Identifier' &&
        node.declarations[0].init?.type === 'CallExpression' &&
        node.declarations[0].init.callee?.type === 'Identifier' &&
        node.declarations[0].init.arguments.length === 0 &&
        ast.body.some(
          (item) => item.type === 'FunctionDeclaration' && item.id?.name === node.declarations[0].init.callee.name,
        ),
    );
    requireProof(rendererDeclarations.length === 1);
    const plainName = rendererDeclarations[0].declarations[0].init.callee.name;
    const plain = ast.body.filter((node) => node.type === 'FunctionDeclaration' && node.id?.name === plainName);
    requireProof(
      plain.length === 1 && !plain[0].async && plain[0].params.length === 0 && plain[0].body.body.length === 2,
    );
    const [declaration, result] = plain[0].body.body,
      rendered = declaration.declarations?.[0],
      construct = rendered?.init,
      portal = construct?.arguments?.[0],
      wrapper = result.argument;
    const verifyPlainDeclaration = () =>
      requireProof(
        declaration.type === 'VariableDeclaration' &&
          declaration.kind === 'const' &&
          declaration.declarations.length === 1 &&
          rendered.id?.type === 'Identifier' &&
          construct?.type === 'CallExpression' &&
          construct.callee?.type === 'Identifier' &&
          sutBindings.has(refs.get(construct.callee)) &&
          construct.arguments.length === 1 &&
          portal?.type === 'ObjectExpression' &&
          portal.properties.length &&
          portal.properties.every(
            (property) =>
              property.type === 'Property' &&
              !property.computed &&
              property.kind === 'init' &&
              !property.method &&
              ['ArrayExpression', 'ObjectExpression'].includes(property.value.type) &&
              (property.value.elements ?? property.value.properties).length === 0,
          ) &&
          result.type === 'ReturnStatement' &&
          wrapper?.type === 'ArrowFunctionExpression' &&
          wrapper.expression &&
          wrapper.params.length === 2 &&
          wrapper.params[0]?.type === 'Identifier' &&
          wrapper.params[1]?.type === 'AssignmentPattern' &&
          wrapper.params[1].left.type === 'Identifier' &&
          wrapper.params[1].right.type === 'ObjectExpression' &&
          !wrapper.params[1].right.properties.length &&
          wrapper.body?.type === 'CallExpression' &&
          wrapper.body.callee?.type === 'MemberExpression' &&
          !wrapper.body.callee.computed &&
          wrapper.body.callee.object?.name === rendered.id.name &&
          wrapper.body.callee.property.name === 'renderString' &&
          wrapper.body.arguments.length === 2 &&
          wrapper.body.arguments[0]?.name === wrapper.params[0].name &&
          wrapper.body.arguments[1]?.name === wrapper.params[1].left.name,
      );
    verifyPlainDeclaration();
    const rendererLocal = row.callback.body.body.find(
      (node) =>
        node.type === 'VariableDeclaration' &&
        node.kind === 'const' &&
        node.declarations.length === 1 &&
        node.declarations[0].init?.type === 'CallExpression' &&
        node.declarations[0].init.callee?.name === plainName &&
        node.declarations[0].init.arguments.length === 0,
    )?.declarations[0].id;
    requireProof(rendererLocal?.type === 'Identifier');
    const allRegistrations = ast.body
      .filter((node) => node.type === 'ExpressionStatement')
      .map((node) => node.expression);
    const allCallbacks = allRegistrations.map((call) => call.arguments[1]);
    requireProof(allCallbacks.includes(row.callback));
    const testVariable = named(testImport.name);
    requireProof(
      testVariable?.references.every((ref) => {
        const call = parents.get(ref.identifier);
        return call?.type === 'CallExpression' && call.callee === ref.identifier && allRegistrations.includes(call);
      }),
    );
    let selectedUnsafe = false;
    const selectedModuleBindings = new Set([named(plainName)]);
    function includeAssertionBindings() {
      for (const item of ast.body)
        if (item.type === 'ImportDeclaration' && ['node:assert', 'node:assert/strict'].includes(item.source.value))
          for (const specifier of item.specifiers) selectedModuleBindings.add(named(specifier.local.name));
    }
    includeAssertionBindings();
    walk(row.callback.body, (node) => {
      if (node.type === 'Identifier' && [fsImport.name, osImport.name, pathImport.name, helperName].includes(node.name))
        selectedUnsafe = true;
      if (node.type === 'Identifier' && refs.has(node)) {
        const variable = refs.get(node);
        if (variable?.scope === moduleScope && !selectedModuleBindings.has(variable)) selectedUnsafe = true;
        if (!variable && node.name !== 'undefined') selectedUnsafe = true;
      }
      if (
        node.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        ![plainName, rendererLocal.name].includes(node.callee.name)
      )
        selectedUnsafe = true;
    });
    requireProof(!selectedUnsafe);
    const plainVariable = named(plainName);
    requireProof(
      plainVariable?.references.every((ref) => {
        const parent = parents.get(ref.identifier);
        return parent?.type === 'CallExpression' && parent.callee === ref.identifier && parent.arguments.length === 0;
      }),
    );
    const helper = named(helperName),
      fsVar = named(fsImport.name),
      osVar = named(osImport.name),
      pathVar = named(pathImport.name);
    requireProof(helper && fsVar && osVar && pathVar);
    const verifyPathReferences = () => {
      for (const ref of pathVar.references) {
        const member = parents.get(ref.identifier),
          call = parents.get(member);
        requireProof(
          member?.type === 'MemberExpression' &&
            member.object === ref.identifier &&
            !member.computed &&
            ['join', 'dirname', 'basename'].includes(member.property.name) &&
            call?.type === 'CallExpression' &&
            call.callee === member,
        );
      }
    };
    verifyPathReferences();
    // No module-scoped or ambient writes, test hooks, asynchronous scheduling or hidden globals.
    const globals = new Set([
      'Buffer',
      'Date',
      'Error',
      'JSON',
      'Object',
      'Set',
      'URL',
      'encodeURIComponent',
      'undefined',
    ]);
    function verifyAmbientMethod(id, parent, grandparent) {
      if (id.name === 'Date')
        requireProof(
          parent.property.name === 'UTC' &&
            grandparent.arguments.every((arg) => arg.type === 'Literal' && typeof arg.value === 'number'),
        );
      else if (id.name === 'JSON') requireProof(parent.property.name === 'stringify');
      else if (id.name === 'Buffer') requireProof(parent.property.name === 'byteLength');
      else if (id.name === 'Object') {
        requireProof(['entries', 'keys', 'hasOwn', 'fromEntries', 'assign'].includes(parent.property.name));
        if (parent.property.name === 'assign')
          requireProof(
            grandparent.arguments[0]?.type === 'NewExpression' &&
              grandparent.arguments[0].callee?.name === 'Error' &&
              !refs.get(grandparent.arguments[0].callee),
          );
      } else fail();
    }
    function verifyAmbientReference(ref) {
      if (ref.resolved) return;
      const id = ref.identifier,
        parent = parents.get(id),
        grandparent = parents.get(parent);
      requireProof(globals.has(id.name));
      if (id.name === 'undefined') return;
      if (['Error', 'Set', 'URL'].includes(id.name)) {
        requireProof(parent?.type === 'NewExpression' && parent.callee === id);
        return;
      }
      if (id.name === 'encodeURIComponent') {
        requireProof(parent?.type === 'CallExpression' && parent.callee === id);
        return;
      }
      if (id.name === 'Date' && parent?.type === 'NewExpression' && parent.callee === id) {
        requireProof(
          parent.arguments.length === 1 &&
            parent.arguments[0]?.type === 'CallExpression' &&
            parent.arguments[0].callee?.type === 'MemberExpression' &&
            parent.arguments[0].callee.object?.name === 'Date' &&
            parent.arguments[0].callee.property.name === 'UTC',
        );
        return;
      }
      requireProof(
        parent?.type === 'MemberExpression' &&
          parent.object === id &&
          !parent.computed &&
          grandparent?.type === 'CallExpression' &&
          grandparent.callee === parent,
      );
      verifyAmbientMethod(id, parent, grandparent);
    }
    const verifyAmbientReferences = () => {
      for (const scope of scopes.scopes) for (const ref of scope.references) verifyAmbientReference(ref);
    };
    verifyAmbientReferences();
    const dynamicAssignments = [],
      dynamicMembers = [];
    function inspectAssignment(node) {
      let target = node.type === 'AssignmentExpression' ? node.left : node.argument;
      const assigned = target;
      let dynamic = false;
      while (target?.type === 'MemberExpression' || target?.type === 'CallExpression') {
        if (target.type === 'MemberExpression') {
          if (target.computed && target.property.type !== 'Literal') dynamic = true;
          target = target.object;
        } else if (
          target.callee?.type === 'MemberExpression' &&
          !target.callee.computed &&
          target.callee.property.name === 'find'
        )
          target = target.callee.object;
        else fail();
      }
      const variable = refs.get(target);
      requireProof(target?.type === 'Identifier' && variable && !['module', 'global'].includes(variable.scope.type));
      if (dynamic) dynamicAssignments.push({ assigned, variable });
    }
    function inspectPattern(node) {
      for (const property of node.properties) {
        if (property.type === 'RestElement') continue;
        requireProof(
          property.type === 'Property' &&
            !property.computed &&
            !['constructor', 'prototype', '__proto__'].includes(property.key?.name ?? property.key?.value),
        );
      }
    }
    walk(ast, (node) => {
      if (node.type === 'ObjectPattern') inspectPattern(node);
      if (node.type === 'MemberExpression') {
        if (node.computed && node.property?.type !== 'Literal') dynamicMembers.push(node);
        let property = node.property?.name;
        if (node.computed) property = node.property?.type === 'Literal' ? node.property.value : null;
        requireProof(!['constructor', 'prototype', '__proto__'].includes(property));
      }
      if (node.type === 'CallExpression' && node.callee?.name === testImport.name)
        requireProof(allRegistrations.includes(node));
      if (node.type === 'MemberExpression' && node.object?.name === testImport.name) fail();
      if (['AssignmentExpression', 'UpdateExpression'].includes(node.type)) inspectAssignment(node);
    });
    const rootVars = new Set(),
      osIdentifiers = new Set();
    const verifyTemporaryRootBindings = () => {
      for (const ref of helper.references) {
        const invoke = parents.get(ref.identifier),
          awaited = parents.get(invoke),
          declarator = parents.get(awaited),
          prefix = invoke?.arguments?.[0];
        requireProof(
          invoke?.type === 'CallExpression' &&
            invoke.callee === ref.identifier &&
            invoke.arguments.length === 1 &&
            awaited?.type === 'AwaitExpression' &&
            declarator?.type === 'VariableDeclarator' &&
            declarator.id.type === 'Identifier' &&
            prefix?.type === 'CallExpression' &&
            prefix.callee?.type === 'MemberExpression' &&
            !prefix.callee.computed &&
            refs.get(prefix.callee.object) === pathVar &&
            prefix.callee.property.name === 'join' &&
            prefix.arguments.length === 2 &&
            prefix.arguments[0]?.type === 'CallExpression' &&
            prefix.arguments[0].callee?.type === 'MemberExpression' &&
            !prefix.arguments[0].callee.computed &&
            refs.get(prefix.arguments[0].callee.object) === osVar &&
            prefix.arguments[0].callee.property.name === 'tmpdir' &&
            prefix.arguments[0].arguments.length === 0 &&
            prefix.arguments[1]?.type === 'Literal' &&
            typeof prefix.arguments[1].value === 'string' &&
            safeName(prefix.arguments[1].value) &&
            !prefix.arguments[1].value.includes('/'),
        );
        const scope = scopes.scopes.find((item) =>
            item.variables.some((variable) => variable.identifiers.includes(declarator.id)),
          ),
          variable = scope?.variables.find((item) => item.identifiers.includes(declarator.id));
        requireProof(variable && !variable.references.some((item) => item.isWrite() && !item.init));
        rootVars.add(variable);
        osIdentifiers.add(prefix.arguments[0].callee.object);
      }
    };
    verifyTemporaryRootBindings();
    requireProof(rootVars.size > 0);
    for (const ref of osVar.references) requireProof(osIdentifiers.has(ref.identifier));
    // The module-level fixture helper may receive additional maps only from frozen source call sites.
    const helperRoots = [...rootVars].filter((variable) => variable.scope.block.type === 'FunctionDeclaration');
    requireProof(helperRoots.length === 1);
    const fixtureFn = helperRoots[0].scope.block,
      fixtureVariable = named(fixtureFn.id.name);
    requireProof(
      fixtureVariable &&
        fixtureFn.params.length === 2 &&
        fixtureFn.params[0].type === 'Identifier' &&
        fixtureFn.params[1].type === 'AssignmentPattern' &&
        fixtureFn.params[1].left.type === 'Identifier' &&
        fixtureFn.params[1].right.type === 'ObjectExpression' &&
        !fixtureFn.params[1].right.properties.length,
    );
    const fixtureExtra = fixtureFn.params[1].left.name,
      maps = [],
      mapExpressions = [],
      forwarders = new Set();
    requireProof(fixtureFn.body.body.length === 4);
    const fixtureRoot = helperRoots[0].identifiers[0].name,
      fixtureContext = fixtureFn.params[0].name;
    const fixtureLoop = fixtureFn.body.body[2],
      pair = fixtureLoop?.left?.declarations?.[0]?.id?.elements;
    requireProof(pair?.length === 2 && pair.every((item) => item?.type === 'Identifier'));
    const key = pair[0].name,
      value = pair[1].name,
      localFile = fixtureLoop.body?.body?.[0]?.declarations?.[0]?.id?.name;
    const rootCall = fixtureFn.body.body[0]?.declarations?.[0]?.init?.argument,
      prefixLiteral = rootCall?.arguments?.[0]?.arguments?.[1];
    const base = fixtureLoop.right?.arguments?.[0]?.properties?.[0]?.argument,
      returned = fixtureFn.body.body[3]?.argument;
    requireProof(
      typeof localFile === 'string' &&
        base?.type === 'Identifier' &&
        prefixLiteral?.type === 'Literal' &&
        returned?.type === 'CallExpression' &&
        returned.callee?.type === 'Identifier' &&
        sutBindings.has(refs.get(returned.callee)),
    );
    const expectedFixture = parseModule(
      `async function ${fixtureFn.id.name}(${fixtureContext}, ${fixtureExtra} = {}) { const ${fixtureRoot} = await ${helperName}(${pathImport.name}.join(${osImport.name}.tmpdir(), ${JSON.stringify(prefixLiteral.value)})); ${fixtureContext}.after(() => ${fsImport.name}.rm(${fixtureRoot}, { recursive: true, force: true })); for (const [${key}, ${value}] of Object.entries({ ...${base.name}, ...${fixtureExtra} })) { const ${localFile} = ${pathImport.name}.join(${fixtureRoot}, ${key}); await ${fsImport.name}.mkdir(${pathImport.name}.dirname(${localFile}), { recursive: true }); await ${fsImport.name}.writeFile(${localFile}, ${value}); } return ${returned.callee.name}(${fixtureRoot}); }`,
    ).body[0];
    requireProof(same(fixtureFn, expectedFixture));
    const checkMap = (node) => {
      mapExpressions.push(node);
      maps.push(inferStaticObjectKeys({ ast, expression: node }));
    };
    let moduleMap = null;
    walk(fixtureFn.body, (node) => {
      if (node.type !== 'ForOfStatement') return;
      const call = node.right;
      if (
        call?.type !== 'CallExpression' ||
        call.callee?.type !== 'MemberExpression' ||
        call.callee.object?.name !== 'Object' ||
        call.callee.property.name !== 'entries' ||
        call.arguments.length !== 1
      )
        return;
      requireProof(!refs.get(call.callee.object));
      const spread = call.arguments[0];
      requireProof(
        spread.type === 'ObjectExpression' &&
          spread.properties.length === 2 &&
          spread.properties.every((item) => item.type === 'SpreadElement' && item.argument.type === 'Identifier') &&
          spread.properties[1].argument.name === fixtureExtra,
      );
      moduleMap = spread.properties[0].argument;
      checkMap(moduleMap);
    });
    requireProof(moduleMap);
    const moduleMapVariable = refs.get(moduleMap);
    requireProof(
      moduleMapVariable?.scope.type === 'module' &&
        moduleMapVariable.references.every((ref) => ref.init || ref.identifier === moduleMap),
    );
    const verifyFixtureReferences = () => {
      for (const ref of fixtureVariable.references) {
        const call = parents.get(ref.identifier);
        requireProof(call?.type === 'CallExpression' && call.callee === ref.identifier && call.arguments.length <= 2);
        if (!call.arguments[1]) continue;
        const argument = call.arguments[1],
          variable = argument.type === 'Identifier' ? refs.get(argument) : null,
          def = variable?.defs?.[0];
        if (def?.type !== 'Parameter') {
          checkMap(argument);
          continue;
        }
        const forwarder = def.node;
        requireProof(
          forwarder.type === 'FunctionDeclaration' &&
            forwarder.params.length === 3 &&
            forwarder.params[2].type === 'AssignmentPattern' &&
            forwarder.params[2].left.name === argument.name &&
            forwarder.params[2].right.type === 'ObjectExpression' &&
            !forwarder.params[2].right.properties.length,
        );
        const forwardVariable = named(forwarder.id.name);
        requireProof(forwardVariable);
        forwarders.add(forwarder.id.name);
        requireProof(variable.references.every((item) => item.init || item.identifier === argument));
        for (const use of forwardVariable.references) {
          const outer = parents.get(use.identifier);
          requireProof(
            outer?.type === 'CallExpression' && outer.callee === use.identifier && outer.arguments.length <= 3,
          );
          if (outer.arguments[2]) checkMap(outer.arguments[2]);
        }
      }
    };
    verifyFixtureReferences();
    const verifyDynamicAssignments = () => {
      for (const { assigned, variable } of dynamicAssignments) {
        let dynamicTarget = assigned;
        while (dynamicTarget?.type === 'MemberExpression' && !dynamicTarget.computed)
          dynamicTarget = dynamicTarget.object;
        const def = variable.defs[0],
          init = def?.node?.init,
          object = dynamicTarget?.object;
        requireProof(
          variable.defs.length === 1 &&
            def?.type === 'Variable' &&
            def.parent?.kind === 'const' &&
            def.node.id?.type === 'ObjectPattern' &&
            def.node.id.properties.some(
              (property) =>
                property.type === 'Property' &&
                !property.computed &&
                property.key.type === 'Identifier' &&
                property.value?.type === 'Identifier' &&
                property.value.name === variable.name,
            ) &&
            init?.type === 'AwaitExpression' &&
            init.argument?.type === 'CallExpression' &&
            init.argument.callee?.type === 'Identifier' &&
            forwarders.has(init.argument.callee.name) &&
            refs.get(init.argument.callee) === named(init.argument.callee.name),
        );
        requireProof(
          dynamicTarget?.type === 'MemberExpression' &&
            dynamicTarget.computed &&
            dynamicTarget.property.type === 'MemberExpression' &&
            object?.type === 'MemberExpression' &&
            !object.computed &&
            object.object?.type === 'Identifier' &&
            refs.get(object.object) === variable,
        );
        let key = dynamicTarget.property;
        while (key?.type === 'MemberExpression') {
          if (key.computed) requireProof(key.property.type === 'Literal' && typeof key.property.value === 'number');
          key = key.object;
        }
        requireProof(key?.type === 'Identifier' && refs.get(key) === variable);
      }
    };
    verifyDynamicAssignments();
    requireProof(
      dynamicMembers.every((node) =>
        dynamicAssignments.some((item) => {
          let target = item.assigned;
          while (target?.type === 'MemberExpression' && !target.computed) target = target.object;
          return target === node;
        }),
      ),
    );
    // Classify each fs target as a fresh owned root or a statically safe path below one.
    const active = new Set();
    function relativeParameter(def, node) {
      const fn = def.node,
        declaration = parents.get(fn),
        binding = declaration?.type === 'VariableDeclarator' ? declaration.id : null;
      const scope = scopes.scopes.find((item) => item.variables.some((value) => value.identifiers.includes(binding))),
        fnVar = scope?.variables.find((value) => value.identifiers.includes(binding));
      requireProof(fnVar && fn.params[0]?.name === node.name);
      const values = [];
      for (const ref of fnVar.references) {
        if (ref.init) continue;
        const call = parents.get(ref.identifier);
        requireProof(
          call?.type === 'CallExpression' &&
            call.callee === ref.identifier &&
            call.arguments[0]?.type === 'Literal' &&
            typeof call.arguments[0].value === 'string' &&
            safeName(call.arguments[0].value),
        );
        values.push(call.arguments[0].value);
      }
      requireProof(values.length > 0);
      return Math.min(...values.map((value) => value.split('/').length));
    }
    function relative(node) {
      if (node?.type === 'Literal' && typeof node.value === 'string') {
        requireProof(safeName(node.value));
        return node.value.split('/').length;
      }
      if (
        node?.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        !node.callee.computed &&
        refs.get(node.callee.object) === pathVar &&
        node.callee.property.name === 'dirname' &&
        node.arguments.length === 1
      ) {
        return Math.max(0, relative(node.arguments[0]) - 1);
      }
      requireProof(node?.type === 'Identifier');
      const variable = refs.get(node),
        def = variable?.defs?.[0];
      requireProof(
        variable?.defs.length === 1 &&
          !active.has(variable) &&
          !variable.references.some((ref) => ref.isWrite() && !ref.init),
      );
      if (def.type === 'Parameter') return relativeParameter(def, node);
      requireProof(def.type === 'Variable');
      requireProof(def.node.id?.type === 'ArrayPattern' && def.node.id.elements[0]?.name === node.name);
      const loop = parents.get(def.parent);
      requireProof(
        loop?.type === 'ForOfStatement' &&
          loop.left === def.parent &&
          loop.right?.type === 'CallExpression' &&
          loop.right.callee?.type === 'MemberExpression' &&
          loop.right.callee.object?.name === 'Object' &&
          !refs.get(loop.right.callee.object) &&
          loop.right.callee.property.name === 'entries' &&
          loop.right.arguments.length === 1,
      );
      if (
        loop.right.arguments[0].type === 'ObjectExpression' &&
        loop.right.arguments[0].properties.some(
          (item) => item.type === 'SpreadElement' && item.argument.name === fixtureExtra,
        )
      ) {
        requireProof(loop === parents.get(parents.get(def.parent)) || fixtureFn.body.body.includes(loop));
        const names = maps.flat();
        requireProof(names.length > 0);
        return Math.min(...names.map((value) => value.split('/').length));
      }
      const names = inferStaticObjectKeys({ ast, expression: loop.right.arguments[0] });
      requireProof(names.length > 0);
      maps.push(names);
      return Math.min(...names.map((value) => value.split('/').length));
    }
    function rooted(node) {
      if (node?.type === 'Identifier') {
        const variable = refs.get(node);
        if (rootVars.has(variable)) return 0;
        requireProof(variable && !active.has(variable));
        active.add(variable);
        try {
          return rooted(fixed(node));
        } finally {
          active.delete(variable);
        }
      }
      requireProof(
        node?.type === 'CallExpression' &&
          node.callee?.type === 'MemberExpression' &&
          !node.callee.computed &&
          refs.get(node.callee.object) === pathVar &&
          ['join', 'dirname'].includes(node.callee.property.name) &&
          node.arguments.length >= 1,
      );
      let depth = rooted(node.arguments[0]);
      if (node.callee.property.name === 'dirname') {
        requireProof(node.arguments.length === 1 && depth > 0);
        return depth - 1;
      }
      for (const arg of node.arguments.slice(1)) depth += relative(arg);
      return depth;
    }
    const isolatedIdentifiers = new Set();
    const verifyFilesystemReferences = () => {
      for (const ref of fsVar.references) {
        const member = parents.get(ref.identifier),
          call = parents.get(member);
        requireProof(
          member?.type === 'MemberExpression' &&
            member.object === ref.identifier &&
            !member.computed &&
            ['mkdir', 'writeFile', 'readFile', 'rm'].includes(member.property.name) &&
            call?.type === 'CallExpression' &&
            call.callee === member &&
            call.arguments.length >= 1,
        );
        rooted(call.arguments[0]);
        isolatedIdentifiers.add(ref.identifier);
      }
    };
    verifyFilesystemReferences();
    requireProof(isolatedIdentifiers.size > 0);
    const cleanupContexts = new Set();
    function inspectRootReference(ref, variable) {
      if (ref.init) return false;
      const call = parents.get(ref.identifier);
      requireProof(call?.type === 'CallExpression' && call.arguments[0] === ref.identifier);
      if (
        call.callee?.type === 'MemberExpression' &&
        refs.get(call.callee.object) === pathVar &&
        !call.callee.computed &&
        call.callee.property.name === 'join'
      ) {
        rooted(call);
        return false;
      }
      if (call.callee?.type === 'Identifier' && sutBindings.has(refs.get(call.callee))) return false;
      requireProof(
        call.callee?.type === 'MemberExpression' &&
          refs.get(call.callee.object) === fsVar &&
          !call.callee.computed &&
          call.callee.property.name === 'rm' &&
          call.arguments.length === 2,
      );
      const options = call.arguments[1];
      requireProof(
        options?.type === 'ObjectExpression' &&
          options.properties.length === 2 &&
          options.properties.every(
            (property) =>
              property.type === 'Property' &&
              !property.computed &&
              ['recursive', 'force'].includes(property.key.name) &&
              property.value?.type === 'Literal' &&
              property.value.value === true,
          ) &&
          new Set(options.properties.map((property) => property.key.name)).size === 2,
      );
      const arrow = parents.get(call),
        after = parents.get(arrow);
      requireProof(
        arrow?.type === 'ArrowFunctionExpression' &&
          arrow.expression &&
          arrow.params.length === 0 &&
          arrow.body === call &&
          after?.type === 'CallExpression' &&
          after.arguments.length === 1 &&
          after.arguments[0] === arrow &&
          after.callee?.type === 'MemberExpression' &&
          !after.callee.computed &&
          after.callee.property.name === 'after' &&
          after.callee.object?.type === 'Identifier',
      );
      const context = refs.get(after.callee.object);
      requireProof(
        context &&
          context.scope === variable.scope &&
          context.defs.length === 1 &&
          context.defs[0].type === 'Parameter',
      );
      cleanupContexts.add(after.callee.object);
      return true;
    }
    const verifyRootCleanup = () => {
      for (const variable of rootVars) {
        let cleanups = 0;
        for (const ref of variable.references) if (inspectRootReference(ref, variable)) cleanups++;
        requireProof(cleanups === 1);
      }
    };
    verifyRootCleanup();
    const verifyCallbackContexts = () => {
      for (const callback of [
        ...allCallbacks,
        fixtureFn,
        ...ast.body.filter((node) => node.type === 'FunctionDeclaration' && forwarders.has(node.id.name)),
      ]) {
        let maxParams = 1;
        if (callback === fixtureFn) maxParams = 2;
        else if (forwarders.has(callback.id?.name)) maxParams = 3;
        requireProof(callback.params.length <= maxParams);
        const context = callback.params[0];
        if (!context) continue;
        requireProof(context.type === 'Identifier');
        const scope = scopes.acquire(callback),
          variable = scope?.variables.find((item) => item.identifiers.includes(context));
        requireProof(variable);
        for (const ref of variable.references) {
          if (ref.init || cleanupContexts.has(ref.identifier)) continue;
          const call = parents.get(ref.identifier);
          requireProof(
            call?.type === 'CallExpression' &&
              call.arguments[0] === ref.identifier &&
              call.callee?.type === 'Identifier' &&
              (call.callee.name === fixtureFn.id.name || forwarders.has(call.callee.name)),
          );
        }
      }
    };
    verifyCallbackContexts();
    const auditMaps = [...mapExpressions],
      audited = new Set();
    function inspectMapReference(ref) {
      if (ref.init || ref.identifier === moduleMap) return;
      const parent = parents.get(ref.identifier);
      if (parent?.type === 'SpreadElement') return;
      requireProof(
        parent?.type === 'CallExpression' &&
          parent.arguments.includes(ref.identifier) &&
          ((parent.callee?.type === 'Identifier' &&
            (parent.callee.name === fixtureFn.id.name || forwarders.has(parent.callee.name))) ||
            (parent.callee?.type === 'MemberExpression' &&
              !parent.callee.computed &&
              parent.callee.object?.name === 'Object' &&
              !refs.get(parent.callee.object) &&
              parent.callee.property.name === 'entries')),
      );
    }
    const verifyMapReferences = () => {
      for (const expression of auditMaps) {
        if (expression.type !== 'Identifier') {
          walk(expression, (node) => {
            if (node.type === 'SpreadElement' && node.argument.type === 'Identifier') auditMaps.push(node.argument);
          });
          continue;
        }
        const variable = refs.get(expression);
        requireProof(variable);
        if (audited.has(variable)) continue;
        audited.add(variable);
        for (const ref of variable.references) inspectMapReference(ref);
        const definition = variable.defs[0];
        if (definition?.type === 'Variable' && definition.node.init?.type === 'ObjectExpression')
          auditMaps.push(definition.node.init);
      }
    };
    verifyMapReferences();
    for (const node of osIdentifiers) isolatedIdentifiers.add(node);
    // Helper itself is input infrastructure; prove and pin its allocation-only export.
    const relativeHelper = path
      .relative(root, path.resolve(root, path.dirname(filePath), helperSource))
      .replaceAll(path.sep, '/');
    const absolute = confined(root, relativeHelper),
      bytes = fs.readFileSync(absolute);
    requireProof(digest(bytes) === digest(Buffer.from(readBaseline(relativeHelper))));
    const helperAst = parseModule(bytes.toString('utf8')),
      helperFs = importBinding(helperAst, 'node:fs/promises', 'default'),
      helperPath = importBinding(helperAst, 'node:path', 'default');
    const exported = helperAst.body.filter(
      (item) => item.type === 'ExportNamedDeclaration' && item.declaration?.id?.name === 'makeTemporaryDirectory',
    );
    requireProof(exported.length === 1);
    const allocator = exported[0].declaration,
      arg = identifier(allocator.params[0]);
    requireProof(
      same(
        allocator,
        parseModule(
          `export async function makeTemporaryDirectory(${arg}) { await ${helperFs.name}.mkdir(${helperPath.name}.dirname(${arg}), { recursive: true }); return ${helperFs.name}.realpath(await ${helperFs.name}.mkdtemp(${arg})); }`,
        ).body[0].declaration,
      ),
    );
    const imports = new Set(['node:fs/promises', 'node:fs', 'node:assert/strict', 'node:os', 'node:path']);
    const verifyAllocatorStatements = () => {
      for (const item of helperAst.body)
        requireProof(
          (item.type === 'ImportDeclaration' &&
            imports.has(item.source.value) &&
            item.specifiers.length === 1 &&
            item.specifiers[0].type === 'ImportDefaultSpecifier') ||
            (item.type === 'ExportNamedDeclaration' && item.declaration?.type === 'FunctionDeclaration') ||
            (item.type === 'VariableDeclaration' &&
              item.kind === 'const' &&
              item.declarations.every(
                (d) =>
                  d.init?.type === 'ArrowFunctionExpression' ||
                  (d.init?.type === 'NewExpression' &&
                    d.init.callee?.name === 'WeakMap' &&
                    d.init.arguments.length === 0),
              )),
        );
    };
    verifyAllocatorStatements();
    return {
      recognizedIdentifiers: new Set(),
      isolatedIdentifiers,
      recognizedBuiltinImports: new Set([osImport.declaration]),
      handledInputSources: new Set([helperSource]),
      dependencies: [{ path: relativeHelper, sha256: digest(bytes) }],
      fixtures: [
        {
          baselineId: row.id,
          bootstrap,
          plainSha256: digest(JSON.stringify(clean(plain[0]))),
          fixtureSha256: digest(JSON.stringify(clean(fixtureFn))),
          mapsSha256: digest(JSON.stringify(maps)),
          helperSha256: digest(bytes),
          isolatedFsCount: fsVar.references.length,
        },
      ],
    };
  } catch {
    return emptyFixtureSlice();
  }
}
function literalEntries(node) {
  requireProof(node?.type === 'ObjectExpression');
  const entries = [],
    seen = new Set();
  for (const prop of node.properties) {
    requireProof(
      prop.type === 'Property' &&
        prop.kind === 'init' &&
        !prop.computed &&
        !prop.method &&
        !prop.shorthand &&
        prop.key.type === 'Literal' &&
        typeof prop.key.value === 'string' &&
        prop.value.type === 'Literal' &&
        typeof prop.value.value === 'string',
    );
    const name = prop.key.value,
      folded = name.toLowerCase();
    requireProof(safeName(name) && !seen.has(folded));
    seen.add(folded);
    entries.push({ name, sha256: digest(Buffer.from(prop.value.value)) });
  }
  // Reject a file that is also another entry's directory on case-insensitive filesystems.
  for (const name of seen) for (const other of seen) requireProof(name === other || !other.startsWith(name + '/'));
  return entries;
}
function entriesWithSpread(node, mapName, base) {
  if (node?.type === 'Identifier' && node.name === mapName) return base;
  if (node?.type !== 'ObjectExpression') return null;
  const properties = [];
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') {
      if (prop.argument.type !== 'Identifier' || prop.argument.name !== mapName) return null;
      properties.push(...base.properties);
    } else properties.push(prop);
  }
  // Spreads and overrides use ordinary object semantics; keep the final value.
  const unique = new Map();
  for (const prop of properties) {
    if (prop.type !== 'Property' || prop.key?.type !== 'Literal' || typeof prop.key.value !== 'string') return null;
    unique.set(prop.key.value, prop);
  }
  return { type: 'ObjectExpression', properties: [...unique.values()] };
}
function ownedReads(ast, { fixtureName, mapName, map, fsName, pathName }) {
  const reads = [],
    nodes = new Set();
  const testImports = ast.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === 'node:test');
  if (
    testImports.length !== 1 ||
    testImports[0].specifiers.length !== 1 ||
    testImports[0].specifiers[0].type !== 'ImportDefaultSpecifier' ||
    testImports[0].specifiers[0].local.name !== 'test'
  )
    return { reads, nodes };
  function inspectOwnedRegistration(statement) {
    const registration = statement.type === 'ExpressionStatement' && statement.expression;
    if (registration?.type !== 'CallExpression' || registration.callee?.name !== 'test') return;
    const callback = registration.arguments[1];
    if (
      !callback?.async ||
      callback.body?.type !== 'BlockStatement' ||
      callback.params.length !== 1 ||
      callback.params[0].type !== 'Identifier'
    )
      return;
    const statements = callback.body.body;
    for (let i = 0; i < statements.length; i++) {
      const declaration = statements[i];
      if (
        declaration.type !== 'VariableDeclaration' ||
        declaration.kind !== 'const' ||
        declaration.declarations.length !== 1
      )
        continue;
      const binding = declaration.declarations[0],
        call = binding.init?.argument;
      if (
        binding.id.type !== 'Identifier' ||
        binding.init?.type !== 'AwaitExpression' ||
        call?.type !== 'CallExpression' ||
        call.callee?.name !== fixtureName ||
        call.arguments.length !== 2 ||
        call.arguments[0]?.name !== callback.params[0].name
      )
        continue;
      const expanded = entriesWithSpread(call.arguments[1], mapName, map);
      if (!expanded) continue;
      let entries;
      try {
        entries = literalEntries(expanded);
      } catch {
        continue;
      }
      const dir = binding.id.name;
      let definitions = 0;
      walk(callback, (item) => {
        if (item.type === 'VariableDeclarator' && bindingNames(item.id).includes(dir)) definitions++;
        if (
          ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(item.type) &&
          item !== callback &&
          item.params.some((param) => bindingNames(param).includes(dir))
        )
          definitions++;
      });
      if (definitions !== 1) continue;
      const collectReads = () => {
        for (const next of statements.slice(i + 1)) {
          const candidate =
            next.type === 'VariableDeclaration' &&
            next.kind === 'const' &&
            next.declarations.length === 1 &&
            next.declarations[0];
          const expression = candidate?.init?.type === 'AwaitExpression' && candidate.init.argument;
          const pathCall = expression?.arguments?.[0];
          const file = pathCall?.arguments?.[1]?.value;
          const isRead =
            expression?.type === 'CallExpression' &&
            expression.callee?.type === 'MemberExpression' &&
            !expression.callee.computed &&
            expression.callee.object?.name === fsName &&
            expression.callee.property.name === 'readFile' &&
            expression.arguments.length === 2 &&
            expression.arguments[1]?.value === 'utf8' &&
            pathCall?.type === 'CallExpression' &&
            pathCall.callee?.type === 'MemberExpression' &&
            !pathCall.callee.computed &&
            pathCall.callee.object?.name === pathName &&
            pathCall.callee.property.name === 'join' &&
            pathCall.arguments.length === 2 &&
            pathCall.arguments[0]?.name === dir &&
            pathCall.arguments[1]?.type === 'Literal' &&
            typeof file === 'string' &&
            entries.some((entry) => entry.name === file);
          let dirUses = 0;
          walk(next, (item) => {
            if (item.type === 'Identifier' && item.name === dir) dirUses++;
          });
          if (isRead && dirUses === 1) {
            nodes.add(expression.callee.object);
            reads.push({
              registrationSha256: digest(JSON.stringify(clean(registration))),
              entry: file,
              entrySha256: entries.find((entry) => entry.name === file).sha256,
            });
          } else if (dirUses) break; // An opaque consumer can mutate or replace any generated file.
        }
      };
      collectReads();
    }
  }
  for (const statement of ast.body) inspectOwnedRegistration(statement);
  return { reads, nodes };
}
// Ignore an unrelated callback's reads only when its fresh fixture root cannot flow into
// the selected source-owned fixture. This is not a claim about SUT or OS isolation.
function isolatedReads(ast, { selectedRow, fixtureName, mapName, map, fsName, pathName, implementationSources }) {
  const empty = () => ({ reads: [], nodes: new Set() });
  const sources = new Set(implementationSources ?? []),
    sutNames = new Set(
      ast.body
        .filter((item) => item.type === 'ImportDeclaration' && sources.has(item.source.value))
        .flatMap((item) => item.specifiers.map((specifier) => specifier.local.name)),
    );
  if (!sutNames.size) return empty();
  const imports = ast.body.filter((item) => item.type === 'ImportDeclaration' && item.source.value === 'node:test');
  if (
    imports.length !== 1 ||
    imports[0].specifiers.length !== 1 ||
    imports[0].specifiers[0].type !== 'ImportDefaultSpecifier'
  )
    return empty();
  const testName = imports[0].specifiers[0].local.name,
    registrations = [],
    moduleNames = new Set();
  const inspectModuleRegistrations = () => {
    for (const item of ast.body) {
      if (item.type === 'ImportDeclaration') {
        for (const part of item.specifiers) moduleNames.add(part.local.name);
        continue;
      }
      if (item.type === 'FunctionDeclaration') {
        moduleNames.add(item.id.name);
        continue;
      }
      if (
        item.type === 'VariableDeclaration' &&
        item.kind === 'const' &&
        item.declarations.length === 1 &&
        item.declarations[0].id?.name === mapName &&
        item.declarations[0].init === map
      ) {
        moduleNames.add(mapName);
        continue;
      }
      const call = item.type === 'ExpressionStatement' && item.expression;
      if (
        call?.type !== 'CallExpression' ||
        call.callee?.type !== 'Identifier' ||
        call.callee.name !== testName ||
        call.arguments.length !== 2 ||
        call.arguments[0]?.type !== 'Literal' ||
        !['FunctionExpression', 'ArrowFunctionExpression'].includes(call.arguments[1]?.type) ||
        call.arguments[1].body?.type !== 'BlockStatement'
      )
        return false;
      registrations.push(call);
    }
    return true;
  };
  if (!inspectModuleRegistrations()) return empty();
  let unsafe = false;
  let scopes;
  try {
    scopes = analyzeScopes(ast, { ecmaVersion: 2022, sourceType: 'module' });
  } catch {
    return empty();
  }
  const resolved = new Map();
  for (const scope of scopes.scopes)
    for (const reference of scope.references) resolved.set(reference.identifier, reference.resolved);
  const parents = new Map();
  walk(ast, (node, parent) => parents.set(node, parent));
  const inspectUnresolvedReferences = () => {
    for (const [node, variable] of resolved) {
      if (variable) continue;
      const parent = parents.get(node);
      if (node.name === 'Object') continue; // Independently restricted to the fixture producer above.
      if (
        node.name === 'Date' &&
        parent?.type === 'NewExpression' &&
        parent.callee === node &&
        parent.arguments.length === 1 &&
        parent.arguments[0]?.type === 'Literal'
      )
        continue;
      if (
        node.name === 'JSON' &&
        parent?.type === 'MemberExpression' &&
        parent.object === node &&
        !parent.computed &&
        parent.property.name === 'stringify' &&
        parents.get(parent)?.type === 'CallExpression' &&
        parents.get(parent).callee === parent
      )
        continue;
      unsafe = true;
    }
  };
  inspectUnresolvedReferences();
  function inspectMutation(node) {
    let target = node.type === 'AssignmentExpression' ? node.left : node.argument;
    while (target?.type === 'MemberExpression' || target?.type === 'CallExpression') {
      if (target.type === 'MemberExpression') target = target.object;
      else if (
        target.callee?.type === 'MemberExpression' &&
        !target.callee.computed &&
        target.callee.property.name === 'find'
      )
        target = target.callee.object;
      else {
        target = null;
        break;
      }
    }
    const variable = resolved.get(target);
    if (
      target?.type !== 'Identifier' ||
      !variable ||
      ['module', 'global'].includes(variable.scope.type) ||
      moduleNames.has(target.name) ||
      ['globalThis', 'process'].includes(target.name)
    )
      unsafe = true;
  }
  walk(ast, (node, parent) => {
    if (
      node.type === 'Identifier' &&
      ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'].includes(node.name)
    )
      unsafe = true;
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === testName &&
      !registrations.includes(node)
    )
      unsafe = true;
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.object.name === testName)
      unsafe = true;
    if (['AssignmentExpression', 'UpdateExpression'].includes(node.type)) inspectMutation(node);
    if (
      node.type === 'Identifier' &&
      node.name === testName &&
      parent?.type !== 'ImportDefaultSpecifier' &&
      !(parent?.type === 'CallExpression' && parent.callee === node && registrations.includes(parent))
    )
      unsafe = true;
  });
  const verifyCallbackIsolation = () => {
    for (const call of registrations) {
      const callback = call.arguments[1],
        context = callback.params[0]?.name;
      if (callback.params.length > 1 || callback.params.some((p) => p.type !== 'Identifier')) unsafe = true;
      walk(callback.body, (node, parent) => {
        if (context && node.type === 'MemberExpression' && node.object?.name === context) unsafe = true;
        if (
          context &&
          node.type === 'Identifier' &&
          node.name === context &&
          !(parent?.type === 'CallExpression' && parent.callee?.name === fixtureName && parent.arguments[0] === node)
        )
          unsafe = true;
      });
    }
  };
  verifyCallbackIsolation();
  if (unsafe) return empty();
  const sutBindings = new Set(
    scopes.scopes
      .filter((scope) => scope.type === 'module')
      .flatMap((scope) => scope.variables.filter((variable) => sutNames.has(variable.name))),
  );
  const reads = [],
    nodes = new Set();
  function inspectUnselectedRegistration(registration) {
    const callback = registration.arguments[1];
    if (callback === selectedRow.callback || !callback.async || callback.params.length !== 1) return;
    const body = callback.body.body;
    function inspectFixtureStatement(statement) {
      if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const' || statement.declarations.length !== 1)
        return;
      const binding = statement.declarations[0],
        setup = binding.init?.argument;
      if (
        binding.id.type !== 'Identifier' ||
        binding.init?.type !== 'AwaitExpression' ||
        setup?.type !== 'CallExpression' ||
        setup.callee?.name !== fixtureName ||
        setup.arguments.length !== 2 ||
        setup.arguments[0]?.type !== 'Identifier' ||
        setup.arguments[0].name !== callback.params[0].name
      )
        return;
      const expanded = entriesWithSpread(setup.arguments[1], mapName, map);
      if (!expanded) return;
      let entries;
      try {
        entries = literalEntries(expanded);
      } catch {
        return;
      }
      const dir = binding.id.name,
        uses = [],
        localReads = [];
      let definitions = 0;
      walk(callback, (node, parent) => {
        if (node.type === 'VariableDeclarator' && bindingNames(node.id).includes(dir)) definitions++;
        if (
          ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) &&
          node !== callback &&
          node.params.some((param) => bindingNames(param).includes(dir))
        )
          definitions++;
        if (node.type === 'Identifier' && node.name === dir && node !== binding.id) uses.push({ node, parent });
        if (
          node.type === 'CallExpression' &&
          node.callee?.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.object?.name === fsName &&
          node.callee.property.name === 'readFile' &&
          node.arguments.length === 2 &&
          node.arguments[1]?.value === 'utf8'
        ) {
          const joined = node.arguments[0],
            file = joined?.arguments?.[1]?.value;
          if (
            joined?.type === 'CallExpression' &&
            joined.callee?.type === 'MemberExpression' &&
            !joined.callee.computed &&
            joined.callee.object?.name === pathName &&
            joined.callee.property.name === 'join' &&
            joined.arguments.length === 2 &&
            joined.arguments[0]?.type === 'Identifier' &&
            joined.arguments[0].name === dir &&
            joined.arguments[1]?.type === 'Literal' &&
            entries.some((entry) => entry.name === file)
          )
            localReads.push({ fs: node.callee.object, joined, file });
        }
      });
      if (definitions !== 1 || !localReads.length) return;
      const allowed = uses.every(
        ({ node, parent }) =>
          parent?.type === 'CallExpression' &&
          parent.arguments[0] === node &&
          ((parent.callee?.type === 'Identifier' && sutBindings.has(resolved.get(parent.callee))) ||
            localReads.some((read) => read.joined === parent)),
      );
      if (!allowed) return;
      for (const read of localReads) {
        nodes.add(read.fs);
        reads.push({
          registrationSha256: digest(JSON.stringify(clean(registration))),
          entry: read.file,
          entrySha256: entries.find((item) => item.name === read.file).sha256,
        });
      }
    }
    for (const statement of body) inspectFixtureStatement(statement);
  }
  for (const registration of registrations) inspectUnselectedRegistration(registration);
  return { reads, nodes };
}
function confined(root, relative) {
  requireProof(typeof relative === 'string' && !path.isAbsolute(relative));
  const resolved = path.resolve(root, relative),
    inside = path.relative(root, resolved);
  requireProof(inside && inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside));
  const real = fs.realpathSync(resolved),
    physicalRoot = fs.realpathSync(root),
    physical = path.relative(physicalRoot, real);
  requireProof(physical && physical !== '..' && !physical.startsWith('..' + path.sep) && !path.isAbsolute(physical));
  return resolved;
}

function isPropertyName(item, parent) {
  return (
    (parent?.type === 'MemberExpression' && parent.property === item && !parent.computed) ||
    (parent?.type === 'Property' && parent.key === item && !parent.computed && !parent.shorthand)
  );
}

/** Returns exact AST nodes permitted by the inferred producer; never marks a subtree as safe. */
export function analyzeGeneratedFixtures({ ast, selected, root, filePath, readBaseline, implementationSources = [] }) {
  function combineSelections() {
    const combined = emptyFixtureSlice(),
      dependencies = new Map();
    for (const entry of selected) {
      const part = analyzeGeneratedFixtures({
        ast,
        selected: [entry],
        root,
        filePath,
        readBaseline,
        implementationSources,
      });
      for (const node of part.recognizedIdentifiers) combined.recognizedIdentifiers.add(node);
      for (const node of part.isolatedIdentifiers) combined.isolatedIdentifiers.add(node);
      for (const node of part.recognizedBuiltinImports) combined.recognizedBuiltinImports.add(node);
      for (const source of part.handledInputSources) combined.handledInputSources.add(source);
      for (const dependency of part.dependencies) {
        requireProof(!dependencies.has(dependency.path) || dependencies.get(dependency.path) === dependency.sha256);
        dependencies.set(dependency.path, dependency.sha256);
      }
      combined.fixtures.push(...part.fixtures);
    }
    combined.dependencies = [...dependencies].map(([name, sha256]) => ({ path: name, sha256 }));
    return combined;
  }
  if (selected.length > 1) return combineSelections();
  function findCandidateCalls() {
    const candidates = [];
    for (const item of selected)
      walk(item.old.callback.body, (node) => {
        if (
          node.type === 'CallExpression' &&
          node.callee.type === 'Identifier' &&
          node.arguments.length === 2 &&
          node.arguments[1]?.type === 'Identifier'
        )
          candidates.push({ node, row: item.old });
      });
    return candidates;
  }
  const candidates = findCandidateCalls();
  const allocatorNames = new Set(
    ast.body
      .filter((node) => node.type === 'ImportDeclaration')
      .flatMap((node) => node.specifiers)
      .filter((node) => node.type === 'ImportSpecifier' && node.imported.name === 'makeTemporaryDirectory')
      .map((node) => node.local.name),
  );
  function findProducerNames() {
    const producerNames = new Set();
    for (const declaration of ast.body.filter((node) => node.type === 'FunctionDeclaration' && node.async)) {
      let usesAllocator = false;
      walk(declaration.body, (node) => {
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && allocatorNames.has(node.callee.name))
          usesAllocator = true;
      });
      if (usesAllocator) producerNames.add(declaration.id.name);
    }
    return producerNames;
  }
  const producerNames = findProducerNames();
  const calls = candidates.filter(({ node }) => producerNames.has(node.callee.name));
  if (!calls.length) return emptyFixtureSlice();
  requireProof(calls.length === 1);
  const { node: call, row } = calls[0],
    name = call.callee.name,
    mapName = identifier(call.arguments[1]);
  requireProof(call.arguments[0].type === 'Identifier' && call.arguments[0].name === row.callback.params[0]?.name);
  const functions = ast.body.filter((item) => item.type === 'FunctionDeclaration' && item.id.name === name);
  const maps = ast.body
    .filter((item) => item.type === 'VariableDeclaration' && item.kind === 'const')
    .flatMap((item) => item.declarations)
    .filter((item) => item.id.type === 'Identifier' && item.id.name === mapName);
  requireProof(functions.length === 1 && maps.length === 1);
  const producer = functions[0],
    entries = literalEntries(maps[0].init);
  requireProof(producer.params.length === 2 && producer.body.body.length === 4);
  const context = identifier(producer.params[0]),
    files = identifier(producer.params[1]);
  const rootName = identifier(producer.body.body[0]?.declarations?.[0]?.id);
  const loop = producer.body.body[2],
    pair = loop?.left?.declarations?.[0]?.id?.elements;
  requireProof(pair?.length === 2);
  const entryName = identifier(pair[0]),
    content = identifier(pair[1]);
  const file = identifier(loop.body.body[0]?.declarations?.[0]?.id);
  const fsImport = importBinding(ast, 'node:fs/promises', 'default'),
    osImport = importBinding(ast, 'node:os', 'default'),
    pathImport = importBinding(ast, 'node:path', 'default');
  const helperImports = ast.body.filter(
    (item) =>
      item.type === 'ImportDeclaration' &&
      item.specifiers.some(
        (part) => part.type === 'ImportSpecifier' && part.imported.name === 'makeTemporaryDirectory',
      ),
  );
  requireProof(helperImports.length === 1 && helperImports[0].specifiers.length === 1);
  const helperImport = helperImports[0],
    helper = identifier(helperImport.specifiers[0].local),
    source = helperImport.source.value;
  requireProof(typeof source === 'string' && /^\.\.?\//u.test(source) && !/[?#\\]/u.test(source));
  const prefix = producer.body.body[0]?.declarations?.[0]?.init?.argument?.arguments?.[0]?.arguments?.[1];
  requireProof(
    prefix?.type === 'Literal' &&
      typeof prefix.value === 'string' &&
      safeName(prefix.value) &&
      !prefix.value.includes('/'),
  );
  const expected = parseModule(
    `async function ${name}(${context}, ${files}) { const ${rootName} = await ${helper}(${pathImport.name}.join(${osImport.name}.tmpdir(), ${JSON.stringify(prefix.value)})); ${context}.after(() => ${fsImport.name}.rm(${rootName}, { recursive: true, force: true })); for (const [${entryName}, ${content}] of Object.entries(${files})) { const ${file} = ${pathImport.name}.join(${rootName}, ${entryName}); await ${fsImport.name}.mkdir(${pathImport.name}.dirname(${file}), { recursive: true }); await ${fsImport.name}.writeFile(${file}, ${content}); } return ${rootName}; }`,
  ).body[0];
  requireProof(same(producer, expected));
  // No shadowing or rebinding of the module bindings used to prove the producer.
  const protectedNames = new Set([name, mapName, helper, fsImport.name, osImport.name, pathImport.name, 'Object']);
  const producerNodes = new Set();
  walk(producer, (node) => producerNodes.add(node));
  function inspectProtectedIdentifier(item, parent) {
    if (item.type !== 'Identifier') return;
    if (item.name === mapName && item !== maps[0].id) {
      requireProof(
        (parent?.type === 'CallExpression' &&
          parent.callee.type === 'Identifier' &&
          parent.callee.name === name &&
          parent.arguments[1] === item) ||
          (parent?.type === 'SpreadElement' && parent.argument === item) ||
          (parent?.type === 'MemberExpression' &&
            parent.object === item &&
            parent.computed &&
            parent.property.type === 'Literal'),
      );
    }
    if (
      item.name === 'Object' &&
      !(parent?.type === 'MemberExpression' && parent.property === item && !parent.computed)
    ) {
      requireProof(producerNodes.has(item));
    }
    if ([fsImport.name, osImport.name, pathImport.name].includes(item.name)) {
      const propertyName = isPropertyName(item, parent);
      requireProof(
        propertyName ||
          parent?.type === 'ImportDefaultSpecifier' ||
          (parent?.type === 'MemberExpression' && parent.object === item && !parent.computed),
      );
    }
    if ([helper, name].includes(item.name)) {
      const propertyName = isPropertyName(item, parent);
      requireProof(
        propertyName ||
          parent?.type === 'ImportSpecifier' ||
          (parent?.type === 'FunctionDeclaration' && parent.id === item) ||
          (parent?.type === 'CallExpression' && parent.callee === item),
      );
    }
  }
  walk(ast, (item, parent) => {
    if (item.type === 'VariableDeclarator' && bindingNames(item.id).some((bound) => protectedNames.has(bound)))
      requireProof(item === maps[0]);
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(item.type) && item.id && protectedNames.has(item.id.name))
      requireProof(item === producer);
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(item.type)) {
      for (const param of item.params)
        walk(param, (part) => {
          if (part.type === 'Identifier') requireProof(!protectedNames.has(part.name));
        });
    }
    if (['AssignmentExpression', 'UpdateExpression'].includes(item.type)) {
      const target = item.type === 'AssignmentExpression' ? item.left : item.argument;
      let base = target;
      while (base?.type === 'MemberExpression') base = base.object;
      requireProof(!(base?.type === 'Identifier' && protectedNames.has(base.name)));
    }
    inspectProtectedIdentifier(item, parent);
  });
  const relative = path.relative(root, path.resolve(root, path.dirname(filePath), source)).replaceAll(path.sep, '/');
  const absolute = confined(root, relative),
    bytes = fs.readFileSync(absolute),
    baseline = Buffer.from(readBaseline(relative));
  requireProof(digest(bytes) === digest(baseline));
  const helperAst = parseModule(bytes.toString('utf8'));
  const helperAllowedImports = new Set(['node:fs/promises', 'node:fs', 'node:assert/strict', 'node:os', 'node:path']);
  for (const item of helperAst.body.filter((item) => item.type === 'ImportDeclaration'))
    requireProof(
      helperAllowedImports.has(item.source.value) &&
        item.specifiers.length === 1 &&
        item.specifiers[0].type === 'ImportDefaultSpecifier',
    );
  const helperFs = importBinding(helperAst, 'node:fs/promises', 'default'),
    helperPath = importBinding(helperAst, 'node:path', 'default');
  const exports = helperAst.body.filter(
    (item) => item.type === 'ExportNamedDeclaration' && item.declaration?.id?.name === 'makeTemporaryDirectory',
  );
  requireProof(exports.length === 1);
  const allocator = exports[0].declaration,
    arg = identifier(allocator.params[0]);
  const expectedAllocator = parseModule(
    `export async function makeTemporaryDirectory(${arg}) { await ${helperFs.name}.mkdir(${helperPath.name}.dirname(${arg}), { recursive: true }); return ${helperFs.name}.realpath(await ${helperFs.name}.mkdtemp(${arg})); }`,
  ).body[0].declaration;
  requireProof(same(allocator, expectedAllocator));
  for (const item of helperAst.body)
    requireProof(
      item.type === 'ImportDeclaration' ||
        (item.type === 'ExportNamedDeclaration' && item.declaration?.type === 'FunctionDeclaration') ||
        (item.type === 'VariableDeclaration' &&
          item.kind === 'const' &&
          item.declarations.every(
            (d) =>
              d.init?.type === 'ArrowFunctionExpression' ||
              (d.init?.type === 'NewExpression' && d.init.callee?.name === 'WeakMap' && d.init.arguments.length === 0),
          )),
    );
  const recognizedIdentifiers = new Set();
  recognizedIdentifiers.add(call.arguments[0]);
  walk(producer, (item) => {
    if (item.type === 'Identifier' && [fsImport.name, osImport.name].includes(item.name))
      recognizedIdentifiers.add(item);
  });
  const provenReads = ownedReads(ast, {
    fixtureName: name,
    mapName,
    map: maps[0].init,
    fsName: fsImport.name,
    pathName: pathImport.name,
  });
  for (const node of provenReads.nodes) recognizedIdentifiers.add(node);
  const isolated = isolatedReads(ast, {
    selectedRow: row,
    fixtureName: name,
    mapName,
    map: maps[0].init,
    fsName: fsImport.name,
    pathName: pathImport.name,
    implementationSources,
  });
  return {
    recognizedIdentifiers,
    isolatedIdentifiers: isolated.nodes,
    recognizedBuiltinImports: new Set([osImport.declaration]),
    handledInputSources: new Set([source]),
    dependencies: [{ path: relative, sha256: digest(bytes) }],
    fixtures: [
      {
        baselineId: row.id,
        producerSha256: digest(JSON.stringify(clean(producer))),
        mapSha256: digest(JSON.stringify(clean(maps[0].init))),
        allocatorSha256: digest(JSON.stringify(clean(allocator))),
        helperPath: relative,
        helperSha256: digest(bytes),
        entries,
        ownedReads: provenReads.reads,
        isolatedReads: isolated.reads,
      },
    ],
  };
}
