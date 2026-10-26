import { DataError } from './data-error.mjs';

const map = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const methods = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'];
const error = (message, status = 400, code = 'ConnectorParameterInvalid') => {
  throw new DataError(message, status, code);
};

// Only local JSON pointers are resolved. External references are never fetched.
function dereference(doc, node, depth = 0) {
  if (!node?.$ref) return node;
  if (typeof node.$ref !== 'string') error('Connector schema reference is invalid.', 501, 'OperationUnsupported');
  if (depth > 32 || !node.$ref.startsWith('#/'))
    error('Connector schema has an unsupported reference.', 501, 'OperationUnsupported');
  const target = node.$ref
    .slice(2)
    .split('/')
    .reduce((v, key) => v?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], doc);
  if (!target) error('Connector schema reference is unresolved.', 501, 'OperationUnsupported');
  return dereference(doc, target, depth + 1);
}

/** Index an explicitly registered Swagger 2.0 definition; operation ids and method/path pairs must be unique. */
export function compileDefinition(doc) {
  if (!map(doc) || doc.swagger !== '2.0' || !map(doc.paths))
    throw new Error('connector definition must be a Swagger 2.0 document with paths');
  const operations = new Map(),
    paths = new Map();
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!map(item)) continue;
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
      const entry = {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        parameters: [...parameters.values()],
      };
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
    ['oneOf', 'anyOf', 'not', 'patternProperties', 'dependencies', 'uniqueItems', 'multipleOf'].some((key) =>
      Object.hasOwn(s, key),
    )
  )
    error('Connector schema uses an unsupported validation constraint.', 501, 'OperationUnsupported');
  if (s.type && !['string', 'integer', 'number', 'boolean', 'object', 'array', 'file'].includes(s.type))
    error('Connector schema has an unsupported type.', 501, 'OperationUnsupported');
  if (
    (s.required !== undefined &&
      !(typeof s.required === 'boolean' && s.in) &&
      (!Array.isArray(s.required) || s.required.some((key) => typeof key !== 'string'))) ||
    (s.allOf !== undefined && !Array.isArray(s.allOf)) ||
    (s.properties !== undefined && !map(s.properties))
  )
    error('Connector schema is malformed.', 501, 'OperationUnsupported');
  if (s.enum !== undefined && !Array.isArray(s.enum))
    error('Connector schema enum is invalid.', 501, 'OperationUnsupported');
  if (s.pattern !== undefined) {
    try {
      if (typeof s.pattern !== 'string') throw new Error();
      new RegExp(s.pattern);
    } catch {
      error('Connector schema pattern is invalid.', 501, 'OperationUnsupported');
    }
  }
  const bad = (why) => error(`Connector parameter ${name} ${why}.`);
  if (s.enum && !s.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) bad('is not an allowed value');
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
    if (s.minLength !== undefined && value.length < s.minLength) bad('is too short');
    if (s.maxLength !== undefined && value.length > s.maxLength) bad('is too long');
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) bad('does not match its pattern');
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
        value = {};
        for (const [key, v] of nested) {
          const parts = key.slice(p.name.length + 1).split('/');
          if (parts.some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part)))
            error('Connector body property path is invalid.');
          let target = value;
          for (const part of parts.slice(0, -1)) {
            if (!map(target)) error('Connector body property path conflicts with another value.');
            target = target[part] ??= {};
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
  return op;
}
