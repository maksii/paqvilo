// Designer calculated-column definitions (FormulaDefinition of a SourceType 1 column) as a bounded program, and its evaluator.
//
// The calculated-column designer stores its formula as Windows Workflow XAML in the vocabulary classic workflows share: an
// Activity root holding one mxswa:Workflow, whose ConditionSequence is the IF / ELSE IF / ELSE chain and whose
// SetEntityProperty on CreatedEntities("primaryEntity#Temp") sets the column. compileCalculatedXaml reads it with the
// non-resolving Solution XML reader (solution-xml.mjs) and compiles the supported subset into plain statements; anything
// else answers { unsupported: reason } naming the first activity or form outside the subset. Nothing is evaluated as VB:
// only the literal patterns below are recognised.
// Supported subset (element local names; prefixes are not resolved):
//   Sequence (with Sequence.Variables), and ActivityReference of Microsoft.Crm.Workflow.Activities:
//     ConditionSequence (Wait False): the first ConditionBranch whose condition holds runs, the later statements are skipped;
//       no branch holding leaves the column null (IF without ELSE). The designer writes ELSE as a last branch on [True].
//     ConditionBranch (Condition [variable], [True] or [False]; Then a Composite, Else a Composite or x:Null), Composite
//     EvaluateExpression: CreateCrmType of a WorkflowPropertyType literal (Boolean, Integer, Decimal, Float, Money,
//       OptionSetValue, String, DateTime, Guid, or the type alone for null); SelectFirstNonNull; Add, Subtract, Multiply,
//       Divide; Concat; AddDays, AddHours, AddWeeks, AddMonths, AddYears, SubtractDays, SubtractHours, SubtractWeeks,
//       SubtractMonths, SubtractYears (amount first, then the date); DiffInDays, DiffInHours, DiffInMinutes, DiffInWeeks,
//       DiffInMonths, DiffInYears (from, to: the result is to - from); TrimLeft, TrimRight (text, count); Now
//     EvaluateCondition: Equal, NotEqual, GreaterThan, GreaterEqual, LessThan, LessEqual, Null, NotNull, BeginsWith,
//       DoesNotBeginWith, EndsWith, DoesNotEndWith, Contains, DoesNotContain; EvaluateLogicalCondition And / Or
//   GetEntityProperty of InputEntities("primaryEntity") or InputEntities("related_<lookup>#<table>") (one N:1 hop)
//   SetEntityProperty of CreatedEntities("primaryEntity#Temp"): the column's value; SetAttributeValue and the designer's
//     three Assign forms around it (the temporary entity, its Id, the copy back) carry no value.
// Bounds: LIMITS (text length, element count, nesting depth, parameters per expression). The statements have no loops, so a
// read runs each one at most once.
// Native (hosted captures 2026-11-26, two runs; evidence summary DATA-04c): AddDays takes the amount first; DiffInDays(a, b)
// is b - a in whole UTC calendar days; a null operand makes arithmetic, date functions and comparisons null or false;
// divide by zero is null; an IF without ELSE is null when it does not hold. Native (designer saves 2026-11-27, two runs;
// summary-F6 DATA-04c2, replay cases dataverse-calculated/designer-dc2): every DiffIn function counts the UTC unit
// boundaries between the two times (Sunday-based weeks); Add/Subtract Months and Years keep the day, clamped to the month's
// last day; TrimLeft/TrimRight drop that many characters and read null as empty text; Concat reads null as empty text; a
// Yes/No value is the literal "1" or "0"; text conditions on a null column do not hold. Assumed (no capture): NotEqual is
// false when an operand is null.
import { parseSolutionXml } from './solution-xml.mjs';
import { compareNumeric, isExactNumeric } from './exact-numeric.mjs';
import { FxError, decimalArithmetic } from './power-fx.mjs';

const LIMITS = Object.freeze({ length: 1024 * 1024, elements: 20_000, depth: 64, parameters: 64 });
const ACTIVITY_NAMESPACE = 'Microsoft.Crm.Workflow.Activities.';
const PROPERTY_TYPE = 'Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.';
const IDENTIFIER = /^[A-Za-z_]\w{0,127}$/;
const COLUMN = /^[a-z_][a-z0-9_]{0,127}$/;
const RELATED = /^related_([a-z0-9_]{1,128})#([a-z0-9_]{1,128})$/;
const OBJECT_LIST = /^\[New Object\(\) \{(.*)\}\]$/s;
const KEYWORDS = new Map([
  ['True', true],
  ['False', false],
  ['Nothing', null],
]);
const DAY = 86_400_000;
const ARITHMETIC = new Map([
  ['Add', '+'],
  ['Subtract', '-'],
  ['Multiply', '*'],
  ['Divide', '/'],
]);
const DATE_ADD = new Set(['Days', 'Hours', 'Weeks', 'Months', 'Years']);
const DIFF = new Set(['DiffInDays', 'DiffInHours', 'DiffInMinutes', 'DiffInWeeks', 'DiffInMonths', 'DiffInYears']);
const TRIM = new Set(['TrimLeft', 'TrimRight']);
const CONDITIONS = new Set([
  'Equal',
  'NotEqual',
  'GreaterThan',
  'GreaterEqual',
  'LessThan',
  'LessEqual',
  'Null',
  'NotNull',
  'BeginsWith',
  'DoesNotBeginWith',
  'EndsWith',
  'DoesNotEndWith',
  'Contains',
  'DoesNotContain',
]);

class Unsupported extends Error {}
const unsupported = (message) => {
  throw new Unsupported(message);
};

const localName = (name) => String(name).split(':').pop();
const tag = (node) => `<${node.name}>`;
function attrOf(node, name) {
  for (const [key, value] of Object.entries(node.attrs ?? {})) if (localName(key) === name) return value;
  return undefined;
}
const elementsOf = (node) => (node?.children ?? []).filter((item) => !item.name.startsWith('#'));

/** Whether a FormulaDefinition is designer XAML (an Activity root), so compileCalculatedXaml reads it. */
export const isCalculatedXaml = (text) =>
  /^\s*(?:\u{FEFF})?(?:<\?xml[^>]*\?>\s*)?<(?:\w+:)?Activity[\s>]/u.test(String(text ?? ''));

// ---- Operands and literals

function variableOf(text, where) {
  const match = /^\[([A-Za-z_]\w{0,127})\]$/.exec(String(text ?? '').trim());
  if (!match || KEYWORDS.has(match[1])) unsupported(`${where} is not a variable reference.`);
  return match[1];
}
// A condition: a variable, or the [True] / [False] keyword the designer writes for ELSE.
function conditionOf(text, where) {
  const value = String(text ?? '').trim();
  if (value === '[True]' || value === '[False]') return { literal: value === '[True]' };
  return { variable: variableOf(value, where) };
}

// The items of a VB object array, read with one sticky pattern: "text" literals ("" escapes a quote) and dotted names,
// separated by commas.
const LIST_ITEM = /\s*(?:"((?:[^"]|"")*)"|([\w.]+))\s*(,|$)/y;
function objectList(text, where) {
  const match = OBJECT_LIST.exec(String(text ?? '').trim());
  if (!match) unsupported(`${where} is not a literal object array.`);
  const source = match[1];
  const items = [];
  if (!source.trim()) return items;
  LIST_ITEM.lastIndex = 0;
  while (LIST_ITEM.lastIndex < source.length) {
    const item = LIST_ITEM.exec(source);
    if (!item) unsupported(`${where} has an item outside the supported literal forms.`);
    items.push(item[1] === undefined ? { name: item[2] } : { text: item[1].replaceAll('""', '"') });
    if (items.length > LIMITS.parameters) unsupported(`${where} has more than ${LIMITS.parameters} items.`);
    if (!item[3]) break;
  }
  return items;
}

const integerOf = (text, where) => {
  if (!/^-?\d{1,15}$/.test(text)) unsupported(`${where}: '${text}' is not an integer literal.`);
  return Number(text);
};
const numberOf = (text, where) => {
  if (!/^-?\d{1,28}(\.\d{1,28})?$/.test(text)) unsupported(`${where}: '${text}' is not a number literal.`);
  return Number(text);
};
const LITERALS = new Map([
  [
    'Boolean',
    (text, where) => {
      // The designer writes "true"/"false" in its conditions and "1"/"0" for a Yes/No value (summary-F6 DATA-04c2).
      const value = { true: true, false: false, 1: true, 0: false }[text.toLowerCase()];
      if (value === undefined) unsupported(`${where}: '${text}' is not a Boolean literal.`);
      return value;
    },
  ],
  ['String', (text) => text],
  ['Integer', integerOf],
  ['OptionSetValue', integerOf],
  ['Decimal', numberOf],
  ['Float', numberOf],
  ['Money', numberOf],
  [
    'DateTime',
    (text, where) => {
      const valid = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]{5,16}(?:Z|[+-]\d{2}:\d{2}))?$/.test(text);
      if (!valid || Number.isNaN(Date.parse(text))) unsupported(`${where}: '${text}' is not an ISO 8601 date literal.`);
      return new Date(Date.parse(text)).toISOString();
    },
  ],
  [
    'Guid',
    (text, where) => {
      const match = /^\{?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\}?$/i.exec(text);
      if (!match) unsupported(`${where}: '${text}' is not a GUID literal.`);
      return match[1].toLowerCase();
    },
  ],
]);
// CreateCrmType: the WorkflowPropertyType, then its text (an optional third item names the attribute type); the type
// alone is null.
function crmLiteral([head, text, ...rest], where) {
  const type = head?.name?.startsWith(PROPERTY_TYPE) ? head.name.slice(PROPERTY_TYPE.length) : null;
  if (type === null) unsupported(`${where} names no WorkflowPropertyType.`);
  if (!LITERALS.has(type)) unsupported(`${where}: WorkflowPropertyType.${type} is outside the supported subset.`);
  if ([text, ...rest].some((item) => item && item.text === undefined))
    unsupported(`${where} mixes variables into a CreateCrmType literal.`);
  return text ? LITERALS.get(type)(text.text, where) : null;
}

// ---- Compiler

// Namespaced attributes (x:Key, x:TypeArguments) and DisplayName carry no behaviour; any other attribute outside the list
// could, so it is refused.
function checkAttributes(node, allowed) {
  for (const key of Object.keys(node.attrs ?? {}))
    if (!key.includes(':') && key !== 'DisplayName' && !allowed.includes(key))
      unsupported(`${tag(node)} has the attribute ${key}, which is outside the supported subset.`);
}

// An ActivityReference's keyed Arguments and Properties.
function referenceParts(node) {
  checkAttributes(node, ['AssemblyQualifiedName']);
  const args = new Map();
  const props = new Map();
  for (const child of elementsOf(node)) {
    const name = localName(child.name);
    const target = { 'ActivityReference.Arguments': args, 'ActivityReference.Properties': props }[name];
    if (!target) unsupported(`${tag(node)} holds ${tag(child)}, which is outside the supported subset.`);
    for (const item of elementsOf(child)) {
      const key = attrOf(item, 'Key');
      if (!key || target.has(key)) unsupported(`${tag(node)} has an unkeyed or repeated argument.`);
      target.set(key, item);
    }
  }
  return { args, props };
}
const argumentText = (node) => (node && localName(node.name) !== 'Null' ? node.text.trim() : null);

const DEFAULTS = new Map([
  ['True', true],
  ['False', false],
  ['[Nothing]', null],
]);
function declare(program, node) {
  const name = attrOf(node, 'Name');
  if (!IDENTIFIER.test(name ?? '')) unsupported('A variable has no valid name.');
  const text = attrOf(node, 'Default');
  if (text !== undefined && !DEFAULTS.has(text))
    unsupported(`Variable ${name} has the default ${text}, which is outside the supported subset.`);
  program.variables.set(name, DEFAULTS.get(text) ?? null);
}
function declareAll(program, collection) {
  for (const node of elementsOf(collection)) {
    if (localName(node.name) !== 'Variable') unsupported(`${tag(node)} is not a variable declaration.`);
    declare(program, node);
  }
}

function compileStatements(program, nodes, depth) {
  if (depth >= LIMITS.depth) unsupported(`The formula nests deeper than ${LIMITS.depth} activities.`);
  return nodes.map((node) => compileStatement(program, node, depth)).filter(Boolean);
}

function compileStatement(program, node, depth) {
  const name = localName(node.name);
  if (name === 'Sequence') {
    checkAttributes(node, []);
    const body = [];
    for (const child of elementsOf(node))
      if (localName(child.name) === 'Sequence.Variables') declareAll(program, child);
      else body.push(child);
    return { op: 'block', steps: compileStatements(program, body, depth + 1) };
  }
  if (name === 'ActivityReference') return compileReference(program, node, depth);
  if (name === 'GetEntityProperty') return compileGet(program, node);
  if (name === 'SetEntityProperty') return compileSet(node);
  if (name === 'SetAttributeValue') return null;
  if (name === 'Assign') return compileAssign(node);
  return unsupported(`The formula uses ${tag(node)}, which is outside the supported subset.`);
}

// The body of a ConditionSequence or a Composite: its variables are declared, its activities compiled.
function compileBody(program, props, depth) {
  if (props.has('Variables')) declareAll(program, props.get('Variables'));
  const body = props.get('Activities');
  return compileStatements(program, body ? elementsOf(body) : [], depth + 1);
}

function compileBranch(program, { args, props }, depth) {
  const branch = (key) => {
    const part = props.get(key);
    if (!part || localName(part.name) === 'Null') return null;
    if (localName(part.name) !== 'ActivityReference') unsupported(`The ${key} of a condition is not an activity.`);
    return [compileReference(program, part, depth + 1)];
  };
  return {
    op: 'branch',
    condition: conditionOf(argumentText(args.get('Condition')), 'ConditionBranch Condition'),
    whenTrue: branch('Then') ?? [],
    whenFalse: branch('Else'),
  };
}

function compileCondition({ args }) {
  const operator = argumentText(args.get('ConditionOperator'));
  if (!CONDITIONS.has(operator)) unsupported(`Condition operator ${operator} is outside the supported subset.`);
  // Null and NotNull carry <x:Null x:Key="Parameters"/>; the comparisons one variable.
  const listed = argumentText(args.get('Parameters'));
  const parameters =
    listed === null
      ? []
      : objectList(listed, 'EvaluateCondition Parameters').map((item) => {
          if (!item.name || !IDENTIFIER.test(item.name)) unsupported('A condition parameter is not a variable.');
          return item.name;
        });
  if (parameters.length !== (operator === 'Null' || operator === 'NotNull' ? 0 : 1))
    unsupported(`Condition operator ${operator} has the wrong number of parameters.`);
  return {
    op: 'condition',
    operator,
    operand: variableOf(argumentText(args.get('Operand')), 'EvaluateCondition Operand'),
    parameters,
    out: variableOf(argumentText(args.get('Result')), 'EvaluateCondition Result'),
  };
}

function compileLogic({ args }) {
  const operator = argumentText(args.get('LogicalOperator'));
  if (operator !== 'And' && operator !== 'Or') unsupported(`Logical operator ${operator} is not And or Or.`);
  return {
    op: 'logic',
    operator,
    left: variableOf(argumentText(args.get('LeftOperand')), 'EvaluateLogicalCondition LeftOperand'),
    right: variableOf(argumentText(args.get('RightOperand')), 'EvaluateLogicalCondition RightOperand'),
    out: variableOf(argumentText(args.get('Result')), 'EvaluateLogicalCondition Result'),
  };
}

const REFERENCES = new Map([
  [
    'ConditionSequence',
    (program, parts, depth) => {
      if (argumentText(parts.args.get('Wait')) !== 'False') unsupported('A calculated column cannot wait.');
      return { op: 'chain', steps: compileBody(program, parts.props, depth) };
    },
  ],
  ['Composite', (program, parts, depth) => ({ op: 'block', steps: compileBody(program, parts.props, depth) })],
  ['ConditionBranch', compileBranch],
  ['EvaluateExpression', (program, parts) => compileExpression(program, parts.args)],
  ['EvaluateCondition', (_program, parts) => compileCondition(parts)],
  ['EvaluateLogicalCondition', (_program, parts) => compileLogic(parts)],
]);

function compileReference(program, node, depth) {
  const qualified = String(attrOf(node, 'AssemblyQualifiedName') ?? '').split(',')[0];
  if (!qualified.startsWith(ACTIVITY_NAMESPACE)) unsupported(`The formula uses activity ${qualified || '(none)'}.`);
  const compile = REFERENCES.get(qualified.slice(ACTIVITY_NAMESPACE.length));
  if (!compile) unsupported(`The formula uses activity ${qualified}, which is outside the supported subset.`);
  return compile(program, referenceParts(node), depth);
}

function compileExpression(program, args) {
  const operator = argumentText(args.get('ExpressionOperator'));
  const items = objectList(argumentText(args.get('Parameters')), `EvaluateExpression ${operator} Parameters`);
  const out = variableOf(argumentText(args.get('Result')), `EvaluateExpression ${operator} Result`);
  if (operator === 'CreateCrmType') return { op: 'literal', value: crmLiteral(items, 'CreateCrmType'), out };
  const parameters = items.map((item) => {
    if (!item.name || !IDENTIFIER.test(item.name))
      unsupported(`EvaluateExpression ${operator} takes variables, not literals.`);
    return item.name;
  });
  const arity = (min, max = min) => {
    const count = min === max ? String(min) : `${min} or more`;
    if (parameters.length < min || parameters.length > max)
      unsupported(`EvaluateExpression ${operator} takes ${count} parameters.`);
  };
  if (operator === 'Now') arity(0);
  else if (operator === 'SelectFirstNonNull' || operator === 'Concat') arity(1, LIMITS.parameters);
  else if (ARITHMETIC.has(operator) || DIFF.has(operator) || dateAdd(operator) || TRIM.has(operator)) arity(2);
  else unsupported(`Expression operator ${operator} is outside the supported subset.`);
  if (operator === 'Now') program.usesNow = true;
  return { op: 'expression', operator, parameters, out };
}
const dateAdd = (operator) => DATE_ADD.has(/^(?:Add|Subtract)(\w+)$/.exec(operator)?.[1]);

function entityOf(node, where) {
  const text = String(attrOf(node, 'Entity') ?? '').trim();
  const match = /^\[(InputEntities|CreatedEntities)\("([^"]{1,300})"\)\]$/.exec(text);
  if (!match) unsupported(`${where} names no entity of the supported subset.`);
  return { scope: match[1], key: match[2] };
}
function columnOf(node, where) {
  const column = String(attrOf(node, 'Attribute') ?? '').toLowerCase();
  if (!COLUMN.test(column)) unsupported(`${where} names no column.`);
  return column;
}

function compileGet(program, node) {
  checkAttributes(node, ['Attribute', 'Entity', 'EntityName', 'Value']);
  const column = columnOf(node, 'GetEntityProperty');
  const { scope, key } = entityOf(node, 'GetEntityProperty');
  const out = variableOf(attrOf(node, 'Value'), 'GetEntityProperty Value');
  if (scope !== 'InputEntities')
    unsupported('GetEntityProperty reads an entity other than the primary or a related one.');
  if (key === 'primaryEntity') {
    program.reads.push({ lookup: null, table: null, column });
    return { op: 'get', lookup: null, table: null, column, out };
  }
  const related = RELATED.exec(key);
  if (!related) unsupported(`GetEntityProperty reads InputEntities("${key}"), which is not a related entity.`);
  const [, lookup, table] = related;
  program.reads.push({ lookup, table, column });
  return { op: 'get', lookup, table, column, out };
}

function compileSet(node) {
  checkAttributes(node, ['Attribute', 'Entity', 'EntityName', 'Value']);
  const { scope, key } = entityOf(node, 'SetEntityProperty');
  if (scope !== 'CreatedEntities' || key !== 'primaryEntity#Temp')
    unsupported('SetEntityProperty sets an entity other than the calculated row.');
  return {
    op: 'set',
    column: columnOf(node, 'SetEntityProperty'),
    value: variableOf(attrOf(node, 'Value'), 'SetEntityProperty Value'),
  };
}

// The designer's Assigns around a SetEntityProperty: a temporary entity, its Id from the primary row, the copy back.
const ASSIGNS = [
  [/^\[CreatedEntities\("primaryEntity#Temp"\)\]$/, /^\[New Entity\("[a-z_][a-z0-9_]{0,127}"\)\]$/],
  [/^\[CreatedEntities\("primaryEntity#Temp"\)\.Id\]$/, /^\[InputEntities\("primaryEntity"\)\.Id\]$/],
  [/^\[InputEntities\("primaryEntity"\)\]$/, /^\[CreatedEntities\("primaryEntity#Temp"\)\]$/],
];
function compileAssign(node) {
  checkAttributes(node, ['To', 'Value']);
  const to = String(attrOf(node, 'To') ?? '').trim(),
    value = String(attrOf(node, 'Value') ?? '').trim();
  if (!ASSIGNS.some(([target, source]) => target.test(to) && source.test(value)))
    unsupported('The formula assigns outside the designer forms of the supported subset.');
  return null;
}

function countElements(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    count += 1;
    if (count > LIMITS.elements) unsupported(`The formula XAML has more than ${LIMITS.elements} elements.`);
    for (const child of node.children) stack.push(child);
  }
}

// The Activity root: x:Members, property elements and the VisualBasic settings carry nothing; one Workflow holds the steps.
function workflowOf(root) {
  if (localName(root.name) !== 'Activity') unsupported(`The formula XAML root is ${tag(root)}, not <Activity>.`);
  const bodies = elementsOf(root).filter((child) => localName(child.name) === 'Workflow');
  for (const child of elementsOf(root)) {
    const name = localName(child.name);
    if (name !== 'Workflow' && name !== 'Members' && !name.includes('.'))
      unsupported(`The formula XAML root holds ${tag(child)}, which is outside the supported subset.`);
  }
  if (bodies.length !== 1) unsupported('The formula XAML holds no single Workflow activity.');
  checkAttributes(bodies[0], []);
  return bodies[0];
}

/**
 * Compiles designer calculated-column XAML into { program } or { unsupported: reason }. Input is untrusted: size, element
 * count and nesting are bounded (LIMITS) and only the literal forms of the subset are read. program.reads lists every
 * column the formula reads ({ lookup, table, column }; lookup is null on the row itself); program.usesNow says whether it
 * reads the current time.
 */
export function compileCalculatedXaml(text) {
  const source = String(text ?? '');
  if (source.length > LIMITS.length)
    return { unsupported: `The formula XAML is longer than ${LIMITS.length} characters.` };
  try {
    const root = parseSolutionXml(source);
    countElements(root);
    const program = { variables: new Map(), reads: [], usesNow: false, steps: [] };
    program.steps = compileStatements(program, elementsOf(workflowOf(root)), 0);
    return { program };
  } catch (error) {
    return {
      unsupported:
        error instanceof Unsupported ? error.message : `The FormulaDefinition is not readable XML: ${error.message}`,
    };
  }
}

// A literal reaches a function only through SelectFirstNonNull (native, hosted creates 2026-11-26: Concat, Multiply, Subtract
// and AddDays that read a CreateCrmType result directly were refused 400 0x80060424, and accepted with the literal wrapped).
function bareLiteralIn(steps, literals = new Set()) {
  for (const step of steps) {
    if (step.op === 'literal') literals.add(step.out);
    else if (step.op === 'expression' && step.operator !== 'SelectFirstNonNull') {
      const bare = step.parameters.find((name) => literals.has(name));
      if (bare) return `EvaluateExpression ${step.operator} reads the literal ${bare} without SelectFirstNonNull.`;
    }
    const nested = [step.steps, step.whenTrue, step.whenFalse].filter(Boolean);
    for (const body of nested) {
      const found = bareLiteralIn(body, literals);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Why the platform refuses a designer calculated-column definition when the column is created, or null. Only the refusal
 * the hosted creates recorded is modelled (a bare literal operand); a definition outside the evaluator's subset is
 * accepted here and reads null on evaluation.
 */
export function calculatedDefinitionError(text) {
  if (!isCalculatedXaml(text)) return null;
  const { program } = compileCalculatedXaml(text);
  return program ? bareLiteralIn(program.steps) : null;
}

// ---- Evaluator

const empty = (value) => value === null || value === undefined || value === '';
const refId = (value) => (value !== null && typeof value === 'object' && !isExactNumeric(value) ? value.id : value);
// A stored value as it compares: a choice's value, a lookup's id (lowercase), a date's time, a number or text.
function comparable(value) {
  if (value === null || value === undefined) return null;
  if (isExactNumeric(value) || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if ('value' in value && !('id' in value)) return comparable(value.value);
    const id = refId(value);
    return id == null ? null : String(id).toLowerCase();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  return value;
}
const isNumeric = (value) => typeof value === 'number' || isExactNumeric(value);
function order(left, right) {
  if (isNumeric(left) && isNumeric(right)) return compareNumeric(left, right);
  if (typeof left === 'string' && typeof right === 'string') {
    const a = left.toLowerCase(),
      b = right.toLowerCase();
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
const text = (value) => String(value).toLowerCase();
const TESTS = new Map([
  ['Equal', (a, b) => order(a, b) === 0],
  ['NotEqual', (a, b) => order(a, b) !== 0],
  ['GreaterThan', (a, b) => order(a, b) > 0],
  ['GreaterEqual', (a, b) => order(a, b) >= 0],
  ['LessThan', (a, b) => order(a, b) < 0],
  ['LessEqual', (a, b) => order(a, b) <= 0],
  ['BeginsWith', (a, b) => text(a).startsWith(text(b))],
  ['DoesNotBeginWith', (a, b) => !text(a).startsWith(text(b))],
  ['EndsWith', (a, b) => text(a).endsWith(text(b))],
  ['DoesNotEndWith', (a, b) => !text(a).endsWith(text(b))],
  ['Contains', (a, b) => text(a).includes(text(b))],
  ['DoesNotContain', (a, b) => !text(a).includes(text(b))],
]);
function condition(step, vars) {
  const operand = vars.get(step.operand) ?? null;
  if (step.operator === 'Null') return empty(operand);
  if (step.operator === 'NotNull') return !empty(operand);
  const left = comparable(operand),
    right = comparable(vars.get(step.parameters[0]) ?? null);
  if (left === null || right === null) return false;
  return TESTS.get(step.operator)(left, right);
}

const asNumber = (value) => {
  const plain = comparable(value);
  if (plain === null || isExactNumeric(plain)) return plain;
  const number = typeof plain === 'string' && plain.trim() !== '' ? Number(plain) : plain;
  if (typeof number !== 'number' || !Number.isFinite(number)) unsupported(`'${value}' is not a number.`);
  return number;
};
const asDate = (value) => {
  if (empty(value)) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) unsupported(`'${value}' is not a date.`);
  return new Date(time);
};
function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}
const utcDay = (date) => Math.floor(date.getTime() / DAY);
// The Sunday-based week of a UTC day (1970-01-01 was a Thursday, day 4 of its week).
const utcWeek = (date) => Math.floor((utcDay(date) + 4) / 7);
// Every DiffIn function counts the unit boundaries between the two UTC times (summary-F6 DATA-04c2: 23:30 to 00:29 is one
// hour, one day and one year; Saturday to the next day is one week).
function difference(operator, from, to) {
  if (operator === 'DiffInDays') return utcDay(to) - utcDay(from);
  if (operator === 'DiffInHours') return Math.floor(to / 3_600_000) - Math.floor(from / 3_600_000);
  if (operator === 'DiffInMinutes') return Math.floor(to / 60_000) - Math.floor(from / 60_000);
  if (operator === 'DiffInWeeks') return utcWeek(to) - utcWeek(from);
  if (operator === 'DiffInYears') return to.getUTCFullYear() - from.getUTCFullYear();
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
}

// TrimLeft and TrimRight (text, count) drop count characters from that end; a null text reads as empty text, and a count
// at least the length leaves empty text (summary-F6 DATA-04c2).
function trimmed(operator, text, count) {
  const value = empty(text) ? '' : String(text);
  const n = Number(isExactNumeric(count) ? count.value : count);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return operator === 'TrimLeft' ? value.slice(n) : value.slice(0, Math.max(0, value.length - n));
}
// Dataverse date and time values lie in 1753-01-01 to 9999-12-31 (Learn "Date and time column behavior and format"); a
// shifted date outside that range reads null (assumed: the platform's answer to an out-of-range result is uncaptured).
const DATE_MIN = Date.UTC(1753, 0, 1);
const DATE_MAX = Date.UTC(10_000, 0, 1) - 1;
const dateResult = (date) => {
  const time = date.getTime();
  return Number.isFinite(time) && time >= DATE_MIN && time <= DATE_MAX ? date.toISOString() : null;
};
function shifted(operator, amount, date) {
  const [, direction, unit] = /^(Add|Subtract)(\w+)$/.exec(operator);
  const count = Math.trunc(Number(isExactNumeric(amount) ? amount.value : amount)) * (direction === 'Add' ? 1 : -1);
  if (!Number.isSafeInteger(count)) return null;
  if (unit === 'Months') return dateResult(addMonths(date, count));
  if (unit === 'Years') return dateResult(addMonths(date, count * 12));
  const size = { Days: DAY, Hours: 3_600_000, Weeks: 7 * DAY }[unit];
  return dateResult(new Date(date.getTime() + count * size));
}

function expression(step, vars, ctx) {
  const values = step.parameters.map((name) => vars.get(name) ?? null);
  const { operator } = step;
  if (operator === 'Now') return new Date(ctx.now()).toISOString();
  if (operator === 'SelectFirstNonNull') return values.find((value) => !empty(value)) ?? null;
  if (operator === 'Concat')
    return values
      .map((value) => {
        if (empty(value)) return '';
        if (typeof value === 'object' && !isExactNumeric(value)) return String(value.name ?? refId(value) ?? '');
        return String(isExactNumeric(value) ? value.value : value);
      })
      .join('');
  if (TRIM.has(operator)) return trimmed(operator, values[0], values[1]);
  if (DIFF.has(operator)) {
    const [from, to] = values.map(asDate);
    return from === null || to === null ? null : difference(operator, from, to);
  }
  if (!ARITHMETIC.has(operator)) {
    const amount = asNumber(values[0]),
      date = asDate(values[1]);
    return amount === null || date === null ? null : shifted(operator, amount, date);
  }
  const [a, b] = values.map(asNumber);
  if (a === null || b === null) return null;
  const result = decimalArithmetic(ARITHMETIC.get(operator), a, b);
  return result instanceof FxError ? null : result;
}

const STEPS = {
  get(step, vars, ctx) {
    const row = step.lookup === null ? ctx.row : ctx.related(step.lookup, step.table);
    vars.set(step.out, row?.[step.column] ?? null);
  },
  literal: (step, vars) => vars.set(step.out, step.value),
  expression: (step, vars, ctx) => vars.set(step.out, expression(step, vars, ctx)),
  condition: (step, vars) => vars.set(step.out, condition(step, vars)),
  logic(step, vars) {
    const left = vars.get(step.left) === true,
      right = vars.get(step.right) === true;
    vars.set(step.out, step.operator === 'And' ? left && right : left || right);
  },
  set(step, vars, ctx, state) {
    if (step.column !== ctx.column) unsupported(`The formula sets ${step.column}, not ${ctx.column}.`);
    state.value = vars.get(step.value) ?? null;
  },
  block: (step, vars, ctx, state) => run(step.steps, vars, ctx, state),
  chain: (step, vars, ctx, state) => runChain(step.steps, vars, ctx, state),
  branch: (step, vars, ctx, state) => runBranch(step, vars, ctx, state),
};
function run(steps, vars, ctx, state) {
  for (const step of steps) STEPS[step.op](step, vars, ctx, state);
}
// A ConditionSequence: the first branch that holds runs, and nothing after it in the sequence.
function runChain(steps, vars, ctx, state) {
  for (const step of steps) {
    if (step.op === 'branch') {
      if (runBranch(step, vars, ctx, state)) return;
    } else run([step], vars, ctx, state);
  }
}
function runBranch(step, vars, ctx, state) {
  const holds = 'literal' in step.condition ? step.condition.literal : vars.get(step.condition.variable) === true;
  if (holds) run(step.whenTrue, vars, ctx, state);
  else if (step.whenFalse) run(step.whenFalse, vars, ctx, state);
  return holds;
}

/**
 * Runs a compiled program for one row: ctx = { row, column, related(lookup, table), now() }. Answers the value the formula
 * sets, or null when no branch sets it. Throws { unsupported } errors (isUnsupported) for a value outside the subset.
 */
export function runCalculatedXaml(program, ctx) {
  const vars = new Map(program.variables);
  const state = { value: null };
  run(program.steps, vars, ctx, state);
  return state.value;
}

/** Whether an error thrown by runCalculatedXaml is a value outside the supported subset (the column reads null). */
export const isUnsupported = (error) => error instanceof Unsupported;
