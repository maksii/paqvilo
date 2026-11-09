// Typed source-bound case guards preserve values and fail closed on mutable-shape changes.
function encodeDate(value) {
  if (
    Object.getPrototypeOf(value) !== Date.prototype ||
    Reflect.ownKeys(value).length ||
    !Object.isExtensible(value) ||
    !Number.isFinite(Date.prototype.getTime.call(value))
  )
    throw Error('unsafe-date');
  return { type: 'date', value: Date.prototype.toISOString.call(value) };
}
function encodeArray(value, active) {
  const d = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    !Object.isExtensible(value) ||
    !d.length?.writable ||
    Object.getOwnPropertySymbols(value).length ||
    Object.keys(d).length !== value.length + 1
  )
    throw Error('unsafe-array');
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const item = d[i];
    if (!item || !item.enumerable || !item.writable || !item.configurable || !Object.hasOwn(item, 'value'))
      throw Error('unsafe-array');
    out.push(encodeTyped(item.value, active));
  }
  return { type: 'array', value: out };
}
function encodeObject(value, active) {
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isExtensible(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw Error('unsafe-object');
  const out = {};
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      !d.enumerable ||
      !d.writable ||
      !d.configurable ||
      !Object.hasOwn(d, 'value')
    )
      throw Error('unsafe-object');
    out[key] = encodeTyped(d.value, active);
  }
  return { type: 'object', value: out };
}
export function encodeTyped(value, active = new Set()) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  if (typeof value === 'string' || typeof value === 'boolean') return { type: typeof value, value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Error('unsupported-number');
    return { type: 'number', value: Object.is(value, -0) ? '-0' : value };
  }
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (typeof value !== 'object' || active.has(value)) throw Error('unsupported-typed-value');
  if (value instanceof Date) return encodeDate(value);
  active.add(value);
  try {
    return Array.isArray(value) ? encodeArray(value, active) : encodeObject(value, active);
  } finally {
    active.delete(value);
  }
}
export function encodeCase(values, names) {
  if (
    !Array.isArray(values) ||
    values.length > names.length ||
    new Set(names).size !== names.length ||
    !names.every((name) => typeof name === 'string' && !['__proto__', 'constructor', 'prototype'].includes(name))
  )
    throw Error('invalid-case');
  const encoded = encodeTyped(values).value;
  return Object.fromEntries(names.map((name, i) => [name, encoded[i] ?? { type: 'undefined' }]));
}

export function typedCaseIndex(cases, names, bindings, binding) {
  if (!Array.isArray(cases) || !Array.isArray(names) || names.length === 0 || !Array.isArray(bindings))
    throw Error('invalid-typed-cases');
  const source = encodeTyped(cases);
  const encoded = source.value.map((row) => {
    const values = names.length === 1 ? [row] : row.type === 'array' ? row.value : null;
    if (!values || values.length > names.length) throw Error('invalid-case');
    return Object.fromEntries(names.map((name, i) => [name, values[i] ?? { type: 'undefined' }]));
  });
  const keys = encoded.map((item) => JSON.stringify(item));
  if (new Set(keys).size !== keys.length || JSON.stringify(encoded) !== JSON.stringify(bindings))
    throw Error('changed-typed-case-universe');
  const actual = encodeTyped(binding);
  if (actual.type !== 'object' || JSON.stringify(Object.keys(actual.value)) !== JSON.stringify(names))
    throw Error('invalid-typed-binding');
  const key = JSON.stringify(actual.value);
  const index = keys.indexOf(key);
  if (index < 0) throw Error('unknown-typed-case');
  return index;
}
