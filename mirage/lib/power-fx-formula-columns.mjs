// The Dataverse formula column dialect of Power Fx: the documented restrictions a formula column cannot use, checked on
// the parsed formula before it is evaluated. The documented function and operator lists are the coverage matrix of
// mirage/test/dataverse-formula-coverage.test.mjs.
//
// Sources (Microsoft Learn): "Formula reference - Dataverse formula columns" (power-platform/power-fx/
// formula-reference-formula-columns) lists the functions; "Work with formula columns" (power-apps/maker/data-platform/
// formula-columns) lists the operators, the data types and the guidelines and limitations.
// The native designer refuses to save a formula that breaks a restriction, so an exported formula column never holds one;
// a locally authored one does. checkFormulaColumn answers the first documented restriction a formula breaks, or null.
// The caller (dataverse-formula.mjs) reads that column as null with FORMULA_UNSUPPORTED naming the restriction.
// Functions outside the documented list are not refused: the list is the documentation's, and an environment may accept
// more. The checker types a node only from literals, the documented functions and the table's column metadata; a node it
// cannot type (If, Switch, an enum, a record) is never refused.
import { parse } from './power-fx.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
import { FORMULA_COLUMN_DECIMAL_LIMIT } from './power-fx-functions.mjs';

/** The documented maximum formula expression length. */
const FORMULA_MAX_LENGTH = 1000;

const TEXT_TYPES = new Set(['nvarchar', 'string', 'memo', 'ntext', 'text', 'varchar', 'email', 'phone', 'url']);
const NUMBER_TYPES = new Set(['int', 'integer', 'bigint', 'decimal', 'float', 'double']);
const CHOICE_TYPES = new Set(['picklist', 'state', 'status', 'choice', 'optionset']);
const LOOKUP_TYPES = new Set(['lookup', 'customer', 'owner']);
// Values "Work with formula columns" keeps out of string functions and implicit text coercion: numbers (whole, decimal or
// currency), date time columns and functions, and choice options ("Create formula columns with ... choice data types").
const NOT_TEXT = new Set(['number', 'currency', 'datetime-local', 'datetime-tzi', 'date', 'choice']);
const NUMERIC = new Set(['number', 'currency']);
const DATES = new Set(['datetime-local', 'datetime-tzi', 'date']);
const COMPARISONS = new Set(['=', '<>', '<', '>', '<=', '>=']);
// "String functions placed wherever a text argument is expected": the text argument positions of each.
const TEXT_ARGUMENTS = {
  Upper: [0],
  Lower: [0],
  Left: [0],
  Right: [0],
  Mid: [0],
  Len: [0],
  Trim: [0],
  TrimEnds: [0],
  StartsWith: [0, 1],
  EndsWith: [0, 1],
  Substitute: [0, 1, 2],
  Replace: [0, 3],
};
const RETURNS = {
  number: [
    'Abs',
    'Average',
    'Decimal',
    'Exp',
    'Float',
    'Int',
    'Len',
    'Ln',
    'Max',
    'Min',
    'Mod',
    'Power',
    'Round',
    'RoundDown',
    'RoundUp',
    'Sqrt',
    'Sum',
    'Trunc',
    'Value',
    'Day',
    'Hour',
    'Minute',
    'Month',
    'Second',
    'Weekday',
    'WeekNum',
    'ISOWeekNum',
    'Year',
    'DateDiff',
  ],
  text: [
    'Char',
    'Concatenate',
    'Left',
    'Lower',
    'Mid',
    'Replace',
    'Right',
    'Substitute',
    'Text',
    'Trim',
    'TrimEnds',
    'Upper',
  ],
  boolean: ['And', 'Or', 'Not', 'IsBlank', 'IsError', 'IsUTCToday', 'StartsWith', 'EndsWith'],
};
const RETURN_KIND = new Map(Object.entries(RETURNS).flatMap(([kind, names]) => names.map((name) => [name, kind])));

const typeName = (definition) => String(definition?.dataverseType ?? definition?.type ?? '').toLowerCase();
const behaviourOf = (definition) =>
  String(
    definition?.behavior ??
      definition?.dateTimeBehavior ??
      definition?.DateTimeBehavior?.Value ??
      definition?.DateTimeBehavior ??
      definition?.format ??
      '',
  ).toLowerCase();

/** The formula-column kind of a column definition: text, number, currency, choice, boolean, lookup, a date kind or null. */
function kindOfDefinition(definition) {
  const type = typeName(definition);
  if (type === 'money') return 'currency';
  if (TEXT_TYPES.has(type)) return 'text';
  if (NUMBER_TYPES.has(type)) return 'number';
  if (CHOICE_TYPES.has(type)) return 'choice';
  if (LOOKUP_TYPES.has(type)) return 'lookup';
  if (type === 'bit' || type === 'boolean') return 'boolean';
  if (type === 'date') return 'date';
  if (type === 'datetime') {
    const behaviour = behaviourOf(definition);
    if (behaviour === 'dateonly') return 'date';
    // Learn "Behavior and format of the date and time column": User Local is the default behaviour.
    return behaviour === 'timezoneindependent' ? 'datetime-tzi' : 'datetime-local';
  }
  return null;
}

const literalNumber = (value) => (isExactNumeric(value) ? Number(value.value) : value);

/**
 * The first documented formula column restriction `expression` breaks, as { construct, message }, or null.
 * columnsOf(table) answers a table's column definitions ({ logical: definition }); table is the formula's own table and
 * column its own logical name (its definition decides whether the decimal range applies).
 */
export function checkFormulaColumn(expression, { table, column, columnsOf }) {
  const text = String(expression ?? '');
  if (text.length > FORMULA_MAX_LENGTH)
    return refusal('length', `The formula is ${text.length} characters long; the maximum is ${FORMULA_MAX_LENGTH}.`);
  let tree;
  try {
    tree = parse(text);
  } catch {
    return null; // a syntax error is the evaluator's to answer
  }
  const fieldsOf = (logical) => columnsOf(logical) ?? {};
  const own = fieldsOf(table);
  const decimalColumn = typeName(own[column]) === 'decimal';
  const fieldOf = (fields, name) => {
    const lower = String(name).toLowerCase();
    if (Object.hasOwn(fields, lower)) return fields[lower];
    return Object.values(fields).find((definition) =>
      [definition?.displayName, definition?.label].some((label) => typeof label === 'string' && label === name),
    );
  };
  // A column reference: { definition, related } for a bare/ThisRecord column or one reached through a lookup.
  const columnOf = (node) => {
    if (node?.t === 'id' && !node.global) {
      const definition = fieldOf(own, node.name);
      return definition ? { definition, related: false, name: node.name } : null;
    }
    if (node?.t === 'dot' && node.obj?.t === 'id') {
      if (node.obj.name === 'ThisRecord') {
        const definition = fieldOf(own, node.name);
        return definition ? { definition, related: false, name: node.name } : null;
      }
      const lookup = fieldOf(own, node.obj.name);
      const target = lookup?.targets?.[0];
      if (!target) return null;
      const definition = fieldOf(fieldsOf(target), node.name);
      return definition ? { definition, related: true, name: `${node.obj.name}.${node.name}` } : null;
    }
    return null;
  };
  const kindOf = (node) => {
    if (!node || typeof node !== 'object') return null;
    switch (node.t) {
      case 'lit':
        if (typeof node.v === 'string') return 'text';
        return typeof node.v === 'boolean' ? 'boolean' : 'number';
      case 'interp':
        return 'text';
      case 'pct':
        return 'number';
      case 'unary':
        return node.op === '!' ? 'boolean' : 'number';
      case 'bin':
        return binaryKind(node);
      case 'id':
      case 'dot': {
        const found = columnOf(node);
        return found ? kindOfDefinition(found.definition) : null;
      }
      case 'call':
        return callKind(node);
      default:
        return null;
    }
  };
  function binaryKind(node) {
    if (node.op === '&') return 'text';
    if (COMPARISONS.has(node.op) || ['&&', '||', 'in', 'exactin'].includes(node.op)) return 'boolean';
    if (['+', '-'].includes(node.op) && [kindOf(node.l), kindOf(node.r)].some((kind) => DATES.has(kind))) return null;
    return 'number';
  }
  function callKind(node) {
    if (node.name === 'Now') return 'datetime-local';
    if (node.name === 'UTCNow') return 'datetime-tzi';
    if (node.name === 'UTCToday') return 'date';
    if (node.name === 'DateAdd') return kindOf(node.args[0]);
    return RETURN_KIND.get(node.name) ?? null;
  }

  // Each node, with the node it is an argument of: the first restriction found wins.
  const visit = (node, parent) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) return visitItems(node, parent);
    if (typeof node.t !== 'string') return null;
    const found = restrictionOf(node, parent);
    if (found) return found;
    for (const [key, value] of Object.entries(node)) {
      if (key === 't' || value === null || typeof value !== 'object') continue;
      const inner = visit(value, node);
      if (inner) return inner;
    }
    return null;
  };
  const visitItems = (items, parent) => {
    for (const item of items) {
      const found = Array.isArray(item) ? visit(item[1], parent) : visit(item?.node ?? item, parent);
      if (found) return found;
    }
    return null;
  };

  function restrictionOf(node, parent) {
    if (node.t === 'lit' && decimalColumn && typeof node.v !== 'string' && typeof node.v !== 'boolean') {
      const value = literalNumber(node.v);
      if (Math.abs(value) > FORMULA_COLUMN_DECIMAL_LIMIT)
        return refusal(
          'literal-range',
          `The literal ${value} is outside the decimal formula column range (-${FORMULA_COLUMN_DECIMAL_LIMIT} to ${FORMULA_COLUMN_DECIMAL_LIMIT}).`,
        );
    }
    if (node.t === 'id' || node.t === 'dot') return currencyRestriction(node, parent);
    if (node.t === 'bin') return binaryRestriction(node);
    if (node.t === 'call') return callRestriction(node);
    return null;
  }

  // "Formula columns don't support using a related table currency column in the formula"; "Direct use of currency columns
  // and exchange rate in the formula is currently unsupported ... achieved through the Decimal function"; "Base currency
  // columns aren't supported".
  function currencyRestriction(node, parent) {
    const found = columnOf(node);
    if (!found || kindOfDefinition(found.definition) !== 'currency') return null;
    if (found.related)
      return refusal(
        'related-currency',
        `The related table currency column ${found.name} can't be used in a formula column.`,
      );
    if (/_base$/i.test(found.name))
      return refusal('base-currency', `The base currency column ${found.name} can't be used in a formula column.`);
    const wrapped = parent?.t === 'call' && parent.name === 'Decimal' && parent.args[0] === node;
    return wrapped
      ? null
      : refusal('currency', `The currency column ${found.name} is used directly; wrap it in Decimal(${found.name}).`);
  }

  function binaryRestriction(node) {
    // "Formula columns don't support using numbers ... In the implicit formulas, such as 12 & "foo""; date time values and
    // choice options are not text either.
    if (node.op === '&')
      for (const side of [node.l, node.r])
        if (NOT_TEXT.has(kindOf(side)))
          return refusal(
            'text-coercion',
            `The & operator converts a ${kindOf(side)} value to text; use Text(value, format).`,
          );
    if (COMPARISONS.has(node.op)) return dateMix('comparison', [node.l, node.r]);
    return null;
  }

  // "User local behavior column can't be compared or used with a DateTime(TZI)/DateOnly behavior column."
  function dateMix(construct, nodes) {
    const kinds = nodes.map(kindOf);
    if (kinds.includes('datetime-local') && kinds.some((kind) => kind === 'datetime-tzi' || kind === 'date'))
      return refusal(
        'date-behaviour',
        `A user local date time value can't be used in a ${construct} with a time zone independent or date only value.`,
      );
    return null;
  }

  function callRestriction(node) {
    const { name, args } = node;
    if (name === 'Text') {
      const textFound = textRestriction(args);
      if (textFound) return textFound;
    }
    // "The Text and Value functions only work with whole numbers, where no decimal separator is involved."
    if (name === 'Value' && args[0]?.t === 'lit' && typeof args[0].v === 'string' && /[.,]/.test(args[0].v))
      return refusal(
        'value-separator',
        `Value("${args[0].v}") needs a decimal separator, which formula columns can't read.`,
      );
    // "StartOfWeek argument isn't supported for the WeekNum and Weekday functions in formula columns."
    if ((name === 'WeekNum' || name === 'Weekday') && args.length > 1)
      return refusal('start-of-week', `The StartOfWeek argument of ${name} is not supported in formula columns.`);
    const found = textArgumentRestriction(name, args);
    if (found) return found;
    if (name === 'DateDiff') return dateMix('DateDiff', args.slice(0, 2));
    return null;
  }

  function textRestriction(args) {
    const kind = kindOf(args[0]);
    // "Formula columns don't support Text() functions with a single argument of type Number."
    if (args.length === 1 && NUMERIC.has(kind))
      return refusal('text-number', 'Text() with a single Number argument is not supported; give a Format argument.');
    // "In the case where a String argument is passed in a Text function then the Format argument isn't supported."
    if (args.length >= 2 && kind === 'text')
      return refusal('text-format', 'Text() with a String argument takes no Format argument.');
    // "Locale-specific formatting tokens such as "." and "," aren't supported in formula columns."
    const format = args[1];
    if (
      args.length >= 2 &&
      NUMERIC.has(kind) &&
      format?.t === 'lit' &&
      typeof format.v === 'string' &&
      /[.,]/.test(format.v)
    )
      return refusal('locale-format', `The Text() format "${format.v}" uses a locale-specific "." or "," token.`);
    return null;
  }

  function textArgumentRestriction(name, args) {
    if (name === 'Concatenate')
      for (const arg of args)
        if (NOT_TEXT.has(kindOf(arg)))
          return refusal('string-argument', `Concatenate receives a ${kindOf(arg)} value; use Text(value, format).`);
    for (const position of TEXT_ARGUMENTS[name] ?? [])
      if (NOT_TEXT.has(kindOf(args[position])))
        return refusal('string-argument', `${name} receives a ${kindOf(args[position])} value where text is expected.`);
    return null;
  }

  return visit(tree, null);
}

const refusal = (construct, message) => ({ construct, message });
