import { DataError } from './data-error.mjs';

// The dataverse spans of flow Dataverse connector calls (connector-runtime.mjs dataverseProvider, docs/design/tracing.md):
// one span per call, module dataverse; the record entries the call drives open none of their own (dataverse-records.mjs).
// Kept here, in a module without imports of the record layer, so dataverse-records.mjs can ask without an import cycle.
const connectorDataverseSpans = new WeakSet();
/** Marks span as the dataverse span of a flow Dataverse connector call. */
export const markConnectorDataverseSpan = (span) => {
  if (span?.spanId) connectorDataverseSpans.add(span);
  return span;
};
/** True when span is the dataverse span of a flow Dataverse connector call. */
export const isConnectorDataverseSpan = (span) => Boolean(span) && connectorDataverseSpans.has(span);

const map = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const methods = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'];
const error = (message, status = 400, code = 'ConnectorParameterInvalid') => {
  throw new DataError(message, status, code);
};

// Only local JSON pointers are resolved. External references are never fetched.
function dereference(doc, node, depth = 0) {
  if (!map(node) || !Object.hasOwn(node, '$ref')) return node;
  if (typeof node.$ref !== 'string') error('Connector schema reference is invalid.', 501, 'OperationUnsupported');
  if (depth > 32 || !node.$ref.startsWith('#'))
    error('Connector schema has an unsupported reference.', 501, 'OperationUnsupported');
  let pointer;
  try {
    pointer = decodeURIComponent(node.$ref.slice(1));
  } catch {
    error('Connector schema reference is invalid.', 501, 'OperationUnsupported');
  }
  if (!pointer.startsWith('/')) error('Connector schema has an unsupported reference.', 501, 'OperationUnsupported');
  const target = pointer
    .slice(1)
    .split('/')
    .reduce((v, key) => {
      if (/~(?![01])/.test(key)) error('Connector schema reference is invalid.', 501, 'OperationUnsupported');
      const member = key.replaceAll('~1', '/').replaceAll('~0', '~');
      return v !== null && typeof v === 'object' && Object.hasOwn(v, member) ? v[member] : undefined;
    }, doc);
  if (!target) error('Connector schema reference is unresolved.', 501, 'OperationUnsupported');
  return dereference(doc, target, depth + 1);
}

// JSON object member order and signed zero do not change an enum value.
function jsonEqual(a, b, depth = 0) {
  if (a === b) return true;
  if (depth > 32) error('Connector enum nests too deeply.', 501, 'OperationUnsupported');
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i], depth + 1))
    );
  if (!map(a) || !map(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key], depth + 1))
  );
}

// A captured definition is data, not a live view of a mutable pack module.
function freezeTree(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeTree(child, seen);
  return Object.freeze(value);
}

/** Index an explicitly registered Swagger 2.0 definition; operation ids and method/path pairs must be unique. */
export function compileDefinition(doc) {
  if (!map(doc) || doc.swagger !== '2.0' || !map(doc.paths))
    throw new Error('connector definition must be a Swagger 2.0 document with paths');
  doc = freezeTree(structuredClone(doc));
  const operations = new Map(),
    paths = new Map();
  for (const [path, rawItem] of Object.entries(doc.paths)) {
    if (path.startsWith('x-')) continue;
    if (!path.startsWith('/')) throw new Error(`invalid connector path ${path}`);
    const item = dereference(doc, rawItem);
    if (!map(item)) throw new Error(`invalid connector path item ${path}`);
    for (const method of methods) {
      const operation = item[method];
      if (!map(operation) || typeof operation.operationId !== 'string' || !operation.operationId.trim()) continue;
      if (operations.has(operation.operationId))
        throw new Error(`duplicate connector operationId ${operation.operationId}`);
      const parameters = new Map();
      for (const raw of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        const p = dereference(doc, raw);
        if (!map(p) || typeof p.name !== 'string' || typeof p.in !== 'string')
          throw new Error('invalid connector parameter');
        parameters.set(`${p.in}:${p.name}`, p);
      }
      const locations = new Map();
      for (const p of parameters.values()) {
        if (locations.has(p.name) && locations.get(p.name) !== p.in)
          throw new Error(`connector parameter ${p.name} occurs in multiple locations`);
        locations.set(p.name, p.in);
      }
      const entry = Object.freeze({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        parameters: Object.freeze([...parameters.values()]),
      });
      operations.set(entry.operationId, entry);
      paths.set(`${entry.method} ${path}`, entry);
    }
  }
  return { doc, operations, paths };
}

function validateValue(doc, raw, value, name, depth = 0) {
  if (depth > 32) error('Connector schema nests too deeply.', 501, 'OperationUnsupported');
  const s = dereference(doc, raw);
  if (!map(s)) error('Connector schema is invalid.', 501, 'OperationUnsupported');
  if (
    ['oneOf', 'anyOf', 'not', 'patternProperties', 'dependencies', 'multipleOf'].some((key) => Object.hasOwn(s, key)) ||
    (Object.hasOwn(s, 'uniqueItems') && s.uniqueItems !== false)
  )
    error('Connector schema uses an unsupported validation constraint.', 501, 'OperationUnsupported');
  if (s.type !== undefined && !['string', 'integer', 'number', 'boolean', 'object', 'array', 'file'].includes(s.type))
    error('Connector schema has an unsupported type.', 501, 'OperationUnsupported');
  if (
    (s.required !== undefined &&
      !(typeof s.required === 'boolean' && s.in) &&
      (!Array.isArray(s.required) || s.required.some((key) => typeof key !== 'string'))) ||
    (s.allOf !== undefined && !Array.isArray(s.allOf)) ||
    (s.properties !== undefined && !map(s.properties)) ||
    (s.items !== undefined && !map(s.items)) ||
    (s.additionalProperties !== undefined &&
      typeof s.additionalProperties !== 'boolean' &&
      !map(s.additionalProperties)) ||
    ['minimum', 'maximum'].some((key) => s[key] !== undefined && !Number.isFinite(s[key])) ||
    ['exclusiveMinimum', 'exclusiveMaximum'].some((key) => s[key] !== undefined && typeof s[key] !== 'boolean') ||
    ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].some(
      (key) => s[key] !== undefined && (!Number.isInteger(s[key]) || s[key] < 0),
    )
  )
    error('Connector schema is malformed.', 501, 'OperationUnsupported');
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length))
    error('Connector schema enum is invalid.', 501, 'OperationUnsupported');
  let pattern;
  if (s.pattern !== undefined) {
    try {
      if (typeof s.pattern !== 'string') throw new Error();
      pattern = new RegExp(s.pattern);
    } catch {
      error('Connector schema pattern is invalid.', 501, 'OperationUnsupported');
    }
  }
  const bad = (why) => error(`Connector parameter ${name} ${why}.`);
  if (s.enum && !s.enum.some((v) => jsonEqual(v, value))) bad('is not an allowed value');
  const type = s.type;
  if (
    type &&
    !(
      {
        string: typeof value === 'string',
        integer: Number.isInteger(value),
        number: typeof value === 'number' && Number.isFinite(value),
        boolean: typeof value === 'boolean',
        object: map(value),
        array: Array.isArray(value),
        file: typeof value === 'string',
      }[type] ?? false
    )
  )
    bad('has an invalid type');
  if (typeof value === 'string') {
    if (s.minLength !== undefined || s.maxLength !== undefined) {
      let length = 0;
      for (let i = 0; i < value.length; i++) {
        length++;
        if (value.codePointAt(i) > 0xffff) i++;
      }
      if (s.minLength !== undefined && length < s.minLength) bad('is too short');
      if (s.maxLength !== undefined && length > s.maxLength) bad('is too long');
    }
    if (pattern && !pattern.test(value)) bad('does not match its pattern');
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && (s.exclusiveMinimum ? value <= s.minimum : value < s.minimum))
      bad('is below its minimum');
    if (s.maximum !== undefined && (s.exclusiveMaximum ? value >= s.maximum : value > s.maximum))
      bad('is above its maximum');
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) bad('has too few items');
    if (s.maxItems !== undefined && value.length > s.maxItems) bad('has too many items');
    if (s.items) value.forEach((v, i) => validateValue(doc, s.items, v, `${name}[${i}]`, depth + 1));
  }
  if (map(value)) {
    if (s.minProperties !== undefined && Object.keys(value).length < s.minProperties) bad('has too few properties');
    if (s.maxProperties !== undefined && Object.keys(value).length > s.maxProperties) bad('has too many properties');
    for (const key of Array.isArray(s.required) ? s.required : [])
      if (!Object.hasOwn(value, key)) bad(`is missing required property ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(s.properties ?? {}, key)) validateValue(doc, s.properties[key], v, `${name}.${key}`, depth + 1);
      else if (s.additionalProperties === false) bad(`contains undeclared property ${key}`);
      else if (map(s.additionalProperties)) validateValue(doc, s.additionalProperties, v, `${name}.${key}`, depth + 1);
    }
  }
  for (const schema of s.allOf ?? []) validateValue(doc, schema, value, name, depth + 1);
}

/** Resolve by operationId or exact method and path template, then validate declared input parameters. */
export function validateDefinition(definition, { operationId, method, path, parameters = {} }) {
  const op = operationId
    ? definition.operations.get(operationId)
    : definition.paths.get(`${String(method).toUpperCase()} ${path}`);
  if (!op || (method && op.method !== String(method).toUpperCase()) || (path && op.path !== path))
    error('The connector definition has no matching operation.', 501, 'OperationUnsupported');
  if (!map(parameters)) error('Connector parameters must be an object.');
  for (const p of op.parameters) {
    let value = Object.hasOwn(parameters, p.name) ? parameters[p.name] : undefined;
    if (p.in === 'body') {
      const nested = Object.entries(parameters).filter(([key]) => key.startsWith(`${p.name}/`));
      if (value !== undefined && nested.length)
        error(`Connector parameter ${p.name} has conflicting body representations.`);
      if (nested.length) {
        // Reject any parent/child pair before construction so no supplied object
        // becomes a mutable reconstruction container, regardless of key order.
        const keys = new Set(nested.map(([key]) => key));
        for (const [key] of nested)
          for (let i = key.indexOf('/', p.name.length + 1); i !== -1; i = key.indexOf('/', i + 1))
            if (keys.has(key.slice(0, i))) error('Connector body property paths overlap.');
        value = {};
        for (const [key, v] of nested) {
          const parts = key.slice(p.name.length + 1).split('/');
          if (parts.some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part)))
            error('Connector body property path is invalid.');
          let target = value;
          for (const part of parts.slice(0, -1)) {
            if (!map(target)) error('Connector body property path conflicts with another value.');
            if (!Object.hasOwn(target, part)) target[part] = {};
            target = target[part];
          }
          if (!map(target)) error('Connector body property path conflicts with another value.');
          target[parts.at(-1)] = v;
        }
      }
    }
    if (value === undefined) {
      if (p.required) error(`Connector parameter ${p.name} is required.`);
      continue;
    }
    validateValue(definition.doc, p.schema ?? p, value, p.name);
  }
  return structuredClone(op);
}
