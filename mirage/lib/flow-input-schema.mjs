// Bounded JSON Schema validation for imported flow inputs and ParseJson actions.
// This is a local subset, not a general schema resolver or code generator.
import { DataError } from './data-error.mjs';
import { isExactNumeric, decimalParts, compareNumeric } from './exact-numeric.mjs';

const own = (value, key) => value != null && Object.hasOwn(value, key);
const map = (value) => value && typeof value === 'object' && !Array.isArray(value) && !isExactNumeric(value);
const types = new Set(['null', 'boolean', 'string', 'number', 'integer', 'array', 'object']);
const combinations = ['allOf', 'anyOf', 'oneOf'];
const unsupportedKeywords = new Set([
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  'not',
  'if',
  'then',
  'else',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'prefixItems',
  'additionalItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const unsupported = (message) => {
  throw new DataError(message, 501, 'LocalFlowUnsupported');
};
const bounded = (depth, state, kind) => {
  if (depth > 32) unsupported('The cloud-flow input schema exceeds the local nesting limit.');
  if (++state[kind] > 10000) unsupported('The cloud-flow input schema exceeds the local validation work limit.');
};

function inspectSchema(schema, depth, state) {
  bounded(depth, state, 'schemas');
  if (typeof schema === 'boolean') return;
  if (!map(schema)) unsupported('A cloud-flow schema must be an object or boolean.');
  for (const key of Object.keys(schema))
    if (unsupportedKeywords.has(key)) unsupported('Unsupported cloud-flow schema keyword: ' + key);
  if (own(schema, 'type')) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declared.length || declared.some((type) => !types.has(type)))
      unsupported('Cloud-flow schema type must name supported JSON types.');
  }
  if (own(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.length))
    unsupported('Cloud-flow schema enum must be a nonempty array.');
  if (
    own(schema, 'required') &&
    (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string'))
  )
    unsupported('Cloud-flow schema required must be an array of property names.');
  if (own(schema, 'properties')) {
    if (!map(schema.properties)) unsupported('Cloud-flow schema properties must be an object.');
    for (const child of Object.values(schema.properties)) inspectSchema(child, depth + 1, state);
  }
  for (const keyword of ['items', 'additionalProperties'])
    if (own(schema, keyword)) inspectSchema(schema[keyword], depth + 1, state);
  for (const keyword of combinations) {
    if (!own(schema, keyword)) continue;
    const branches = schema[keyword];
    if (!Array.isArray(branches) || !branches.length)
      unsupported('Cloud-flow schema ' + keyword + ' must be a nonempty array of schemas.');
    for (const branch of branches) inspectSchema(branch, depth + 1, state);
  }
}

function equalValue(a, b, depth, state) {
  bounded(depth, state, 'checks');
  if (isExactNumeric(a) || isExactNumeric(b))
    return (
      (isExactNumeric(a) || typeof a === 'number') &&
      (isExactNumeric(b) || typeof b === 'number') &&
      compareNumeric(a, b) === 0
    );
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => own(b, key) && equalValue(a[key], b[key], depth + 1, state))
  );
}

function validate(value, schema, name, depth, state) {
  bounded(depth, state, 'checks');
  const invalid = (message) => {
    throw new DataError(`Cloud-flow input ${name} ${message}.`, 400, 'InvalidRequest');
  };
  if (schema === true) return;
  if (schema === false) invalid('is rejected by a false schema');
  const matches = (type) =>
    type === 'null'
      ? value === null
      : type === 'array'
        ? Array.isArray(value)
        : type === 'object'
          ? Boolean(map(value))
          : type === 'integer'
            ? Number.isInteger(value) || (isExactNumeric(value) && decimalParts(value).scale === 0)
            : type === 'number'
              ? (typeof value === 'number' && Number.isFinite(value)) || isExactNumeric(value)
              : typeof value === type;
  if (schema.type && ![schema.type].flat().some(matches)) invalid('has an invalid type');
  if (schema.enum && !schema.enum.some((entry) => equalValue(entry, value, depth, state)))
    invalid('is not an allowed value');
  for (const keyword of combinations) {
    if (!own(schema, keyword)) continue;
    let matching = 0;
    for (const branch of schema[keyword]) {
      try {
        validate(value, branch, name, depth + 1, state);
        matching++;
      } catch (error) {
        if (error.code !== 'InvalidRequest') throw error;
      }
    }
    if (
      (keyword === 'allOf' && matching !== schema[keyword].length) ||
      (keyword === 'anyOf' && matching === 0) ||
      (keyword === 'oneOf' && matching !== 1)
    )
      invalid('does not satisfy ' + keyword);
  }
  if (map(value)) {
    for (const key of schema.required ?? []) if (!own(value, key)) invalid('is missing required property ' + key);
    for (const [key, child] of Object.entries(value)) {
      if (own(schema.properties, key)) validate(child, schema.properties[key], name + '.' + key, depth + 1, state);
      else if (schema.additionalProperties === false) invalid('contains undeclared property ' + key);
      else if (own(schema, 'additionalProperties'))
        validate(child, schema.additionalProperties, name + '.' + key, depth + 1, state);
    }
  }
  if (Array.isArray(value) && own(schema, 'items'))
    value.forEach((child, index) => validate(child, schema.items, name + '[' + index + ']', depth + 1, state));
}

export function validateFlowInput(value, schema = {}, name = 'body', depth = 0) {
  const state = { schemas: 0, checks: 0 };
  inspectSchema(schema, depth, state);
  validate(value, schema, name, depth, state);
}
