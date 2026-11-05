import { isExactNumeric, parseNumericLiteral, decimalParts } from './exact-numeric.mjs';
const canonical = (value) => (isExactNumeric(value) ? value.value : String(value));
const TYPES = new Set([
  'Edm.String',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Boolean',
  'Edm.Date',
  'Edm.DateTimeOffset',
  'Edm.Guid',
]);
export function dataverseHttpReaderContext({ method, route, headers, bodyBuffer }) {
  const type = String(Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''),
    hasJsonBody = Boolean(bodyBuffer?.length) && /json/i.test(type);
  let lexemes;
  return {
    method,
    entitySet: route?.set,
    recordPayload: ['collection', 'entity'].includes(route?.kind),
    hasJsonBody,
    ieee754Compatible: /(?:^|;)\s*IEEE754Compatible\s*=\s*(?:true|"true")\s*(?:;|$)/i.test(type),
    numberLexemeFor: hasJsonBody
      ? (property, value) => {
          lexemes ??= scalarNumberLexemes(bodyBuffer.toString('utf8'));
          return lexemes(property, value);
        }
      : undefined,
  };
}
// Request-scoped lexical facts indexed by property plus exact canonical numeric
// value. If same-named nested values have conflicting spellings, no lexical
// classification is admitted. Cloning/deep insert cannot misattribute a token.
export function scalarNumberLexemes(source) {
  const map = new Map();
  JSON.parse(String(source).replace(/^\uFEFF/, ''), function (key, value, context) {
    if (typeof value === 'number' && context?.source) {
      const k = key + '\0' + canonical(parseNumericLiteral(context.source)),
        old = map.get(k);
      map.set(k, old === undefined || old === context.source ? context.source : null);
    }
    return value;
  });
  return (property, value) => map.get(property + '\0' + canonical(value)) ?? undefined;
}

function decimalFormatConflict(value, expectedType, ieee754Compatible) {
  return (
    expectedType === 'Edm.Decimal' &&
    ((typeof value === 'string' && !ieee754Compatible) ||
      ((typeof value === 'number' || isExactNumeric(value)) && ieee754Compatible))
  );
}

function sourceTypeOf(value, numericLexeme) {
  let sourceType;
  if (typeof value === 'boolean') sourceType = 'Edm.Boolean';
  else if (typeof value === 'string') sourceType = 'Edm.String';
  else sourceType = null;
  if (
    (typeof value === 'number' || isExactNumeric(value)) &&
    typeof numericLexeme === 'string' &&
    /^-?\d+(?:\.\d+)?$/.test(numericLexeme)
  ) {
    const parts = decimalParts(numericLexeme),
      n = parts?.coefficient;
    if (parts && parts.scale <= 28 && (n < 0n ? -n : n) <= 79228162514264337593543950335n)
      if (!numericLexeme.includes('.') && parts.scale === 0 && n >= -2147483648n && n <= 2147483647n)
        sourceType = 'Edm.Int32';
      else sourceType = 'Edm.Decimal';
  }
  return sourceType;
}

function stringConversionCause(value, expectedType, literal) {
  if (
    ['Edm.Int32', 'Edm.Int64', 'Edm.Decimal'].includes(expectedType) &&
    /^[\t-\r ]*[+-]?\d+(?:\.\d*)?[\t-\r ]*$/.test(value)
  )
    return null;
  if (expectedType === 'Edm.Boolean') return 'String was not recognized as a valid Boolean.';
  if (expectedType === 'Edm.Guid')
    return 'Guid should contain 32 digits with 4 dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).';
  if (expectedType === 'Edm.DateTimeOffset') return `The string '${literal}' is not a valid AllXsd value.`;
  if (expectedType === 'Edm.Date') return `String '${literal}' was not recognized as a valid Edm.Date.`;
  if (['Edm.Int32', 'Edm.Int64', 'Edm.Double', 'Edm.Decimal'].includes(expectedType))
    return 'Input string was not in a correct format.';
  return null;
}

export function dataverseScalarCause(value, expectedType, { numericLexeme, ieee754Compatible = false } = {}) {
  if (!TYPES.has(expectedType)) return null;
  if (value === null || (typeof value === 'object' && !isExactNumeric(value))) return null;
  if (decimalFormatConflict(value, expectedType, ieee754Compatible))
    return `Cannot convert a value to target type '${expectedType}' because of conflict between input format string/number and parameter 'IEEE754Compatible' false/true.`;
  let literal;
  if (typeof value === 'boolean') literal = value ? 'True' : 'False';
  else literal = numericLexeme ?? canonical(value);
  const head = `Cannot convert the literal '${literal}' to the expected type '${expectedType}'.`;
  const sourceType = sourceTypeOf(value, numericLexeme);
  if (sourceType === 'Edm.String') {
    // A syntactically numeric string outside its CLR range has an overflow cause, which is not reported separately;
    // it keeps the generic diagnostic.
    const cause = stringConversionCause(value, expectedType, literal);
    return cause ? head + ' ---> System.FormatException: ' + cause : null;
  }
  if (sourceType && sourceType !== expectedType)
    return (
      head +
      ` ---> Microsoft.OData.ODataException: Cannot convert a value of type '${sourceType}' to the expected target type '${expectedType}'.`
    );
  return null;
}
