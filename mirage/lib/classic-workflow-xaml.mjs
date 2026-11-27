// Classic workflow designer XAML (workflow category 0) as a bounded step model, and its interpreter.
//
// The exported XAML is Windows Workflow markup in the Microsoft.Xrm.Sdk.Workflow.Activities vocabulary that business rules
// share (an Activity root holding one mxswa:Workflow). parseClassicWorkflow reads it with the non-resolving Solution XML
// reader and compiles the supported subset into plain steps; anything else answers { unsupported: reason } naming the first
// activity or form outside the subset. Nothing is evaluated as VB: only the literal patterns below are recognised.
// Supported subset (element local names; prefixes are not resolved):
//   Sequence (with Sequence.Variables), Persist (no effect)
//   ActivityReference of Microsoft.Crm.Workflow.Activities:
//     ConditionSequence (Wait False): its ConditionBranch children are an if / else-if / default chain, the first branch
//       whose condition holds runs and the later ones are skipped
//     ConditionBranch (Condition [var], [True] or [False]; Then and Else Composite or x:Null), Composite
//     EvaluateExpression: CreateCrmType with a WorkflowPropertyType literal (Boolean, DateTime, Decimal, Float, Integer,
//       EntityReference, Money, OptionSetValue, Guid, String, or the type alone for null), SelectFirstNonNull of variables
//     EvaluateCondition: Equal, NotEqual, Null, NotNull, GreaterThan, GreaterEqual, LessThan, LessEqual, BeginsWith,
//       DoesNotBeginWith, EndsWith, DoesNotEndWith, Contains, DoesNotContain
//     EvaluateLogicalCondition And / Or, ConvertCrmXrmTypes
//   GetEntityProperty / SetEntityProperty on InputEntities("primaryEntity"), InputEntities("related_<lookup>#<table>")
//     (the N:1 row the primary row's lookup names, read once) or CreatedEntities("<key>")
//   Assign of CreatedEntities("<key>") = New Entity("<table>"), of an entity's .Id from another entity's .Id or Guid.Empty,
//     and of one entity variable to another
//   UpdateEntity and CreateEntity of a CreatedEntities entity (the attributes SetEntityProperty set), SetState with literal
//     State and Status OptionSetValues, TerminateWorkflow with InvalidPluginExecutionException(OperationStatus.Succeeded or
//     Canceled, <variable>) as Stop workflow with its status and message
//   Waits (Learn "Configure workflow stages and steps": Wait conditions, Parallel wait branch; SDK Postpone):
//     ConditionSequence Wait True: its branches are wait branches; the first whose condition holds runs, and when none
//       holds the run suspends until a later change of the record makes one hold (each later write re-evaluates them)
//     Postpone with BlockExecution True and PostponeUntil [variable] (a DateTime): the run suspends until that time;
//       BlockExecution False does not suspend
//     The process designer's Timeout wait branch (summary-F6 DATA-04c2): RetrieveLastExecutionTime, the due column, an
//       optional XrmTimeSpan offset added to it (Add with a DateTime target type), Assign IIf(IsNothing(d), DateTime.MaxValue,
//       d), Assign UtcNow >= DirectCast(d, DateTime).ToUniversalTime(), and a non-blocking Postpone to the due time as the
//       branch's Else; a wait that suspends with such a branch wakes at its earliest due time, or earlier on a write of a
//       column its branches read
//   A suspended run answers { status: 'waiting', wait, snapshot }; runClassicWorkflow(program, host, { resume: snapshot })
//   continues it at the step that suspended, which is evaluated again (a wait reads the record as it is then).
// Bounds: XAML_LIMITS (text length, element count, activity nesting depth, parameters per expression). The step model has no
// loops, so a run executes each compiled step at most once.
// The designer forms, the step log, the Stop, failure and wait outcomes follow hosted session F6 (summary-F6 OPS-01d,
// replayed by mirage/test/parity/cases/classic-workflow/hosted-f6.json); Postpone is a local model (the Web API refuses
// it, so no hosted run of it exists). Also local: variables are one flat map per run; string conditions compare without
// case. A run's writes go through the host (dataverse-workflows.mjs: the records pipeline as the run-as user).
// A run that fails at a step with options.suspendOnFailure answers { status: 'failed', error, logs, snapshot } instead of
// throwing; its snapshot resumes at the failing step.
import { parseSolutionXml } from './solution-xml.mjs';

const XAML_LIMITS = Object.freeze({ length: 1024 * 1024, elements: 20_000, depth: 64, parameters: 64 });

const ACTIVITY_NAMESPACE = 'Microsoft.Crm.Workflow.Activities.';
const PROPERTY_TYPE = 'Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.';
const IDENTIFIER = /^[A-Za-z_]\w{0,127}$/;
const COLUMN = /^[a-z_][a-z0-9_]{0,127}$/;
const GUID = /^\{?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\}?$/i;
const ENTITY_REF = /^\[(InputEntities|CreatedEntities)\("([^"]{1,200})"\)(\.Id)?\]$/;
const NEW_ENTITY = /^\[New Entity\("([a-z_][a-z0-9_]{0,127})"\)\]$/i;
// The designer's Timeout wait (summary-F6 DATA-04c2): an unset due time becomes DateTime.MaxValue, then the condition is
// "the current UTC time is at or past the due time".
const OR_MAX =
  /^\[Microsoft\.VisualBasic\.IIf\(Microsoft\.VisualBasic\.IsNothing\(([A-Za-z_]\w{0,127})\), DateTime\.MaxValue, ([A-Za-z_]\w{0,127})\)\]$/;
const PAST_DUE = /^\[DateTime\.UtcNow >= DirectCast\(([A-Za-z_]\w{0,127}), System\.DateTime\)\.ToUniversalTime\(\)\]$/;
const DATE_MIN_VALUE = '0001-01-01T00:00:00.000Z';
const DATE_MAX_VALUE = '9999-12-31T23:59:59.999Z';
const TIME_SPAN_PARTS = ['Years', 'Months', 'Days', 'Hours', 'Minutes'];
const OBJECT_LIST = /^\[New Object\(\) \{(.*)\}\]$/s;
const TERMINATE =
  /^\[New Microsoft\.Xrm\.Sdk\.InvalidPluginExecutionException\(Microsoft\.Xrm\.Sdk\.OperationStatus\.(\w+), ([A-Za-z_]\w{0,127})\)\]$/;
// The designer's Stop workflow: the status in a one-argument exception, the message in Reason (summary-F6 OPS-01d).
const TERMINATE_STATUS =
  /^\[New Microsoft\.Xrm\.Sdk\.InvalidPluginExecutionException\(Microsoft\.Xrm\.Sdk\.OperationStatus\.(\w+)\)\]$/;
const REASON = /^\[(?:DirectCast\(([A-Za-z_]\w{0,127}), System\.String\)|([A-Za-z_]\w{0,127}))\]$/;
// A designer step: its DisplayName is <kind>Step<number>, optionally followed by ": <label>". Logs name it Step_<number>.
const STEP_NAME = /^([A-Za-z]{1,64}Step)(\d{1,6})(?::[\s\S]*)?$/;
const MAX_DEFAULT = 4000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]{5,16}(?:Z|[+-]\d{2}:\d{2})$/;
const RELATED = /^related_([a-z0-9_]{1,128})#([a-z0-9_]{1,128})$/i;
const KEYWORDS = new Set(['True', 'False', 'Nothing']);
const CONDITIONS = new Set([
  'Equal',
  'NotEqual',
  'Null',
  'NotNull',
  'GreaterThan',
  'GreaterEqual',
  'LessThan',
  'LessEqual',
  'BeginsWith',
  'DoesNotBeginWith',
  'EndsWith',
  'DoesNotEndWith',
  'Contains',
  'DoesNotContain',
]);
const TYPES = new Map([
  ['x:String', 'string'],
  ['x:Boolean', 'boolean'],
  ['x:Int32', 'integer'],
  ['x:Decimal', 'decimal'],
  ['x:Double', 'float'],
  ['s:DateTime', 'datetime'],
  ['s:Guid', 'guid'],
  ['mxs:Money', 'money'],
  ['mxs:OptionSetValue', 'optionset'],
  ['mxs:EntityReference', 'reference'],
]);

class Unsupported extends Error {}

// What one parse collects besides the steps: GUID literals by variable (an EntityReference may take its id from one), the
// lookup literals activation checks (with the designer steps around each, innermost first), the names of the open
// designer steps, and the forms the Web API refuses although they run (Postpone, an unpreserved RetrieveCurrentTime).
let context = null;
const newContext = () => ({ guids: new Map(), references: [], ancestors: [], webApi: [] });
const unsupported = (message) => {
  throw new Unsupported(message);
};

/** A failure of an interpreted run (a step that cannot be carried out): the job fails, a real-time write is refused. */
class ClassicWorkflowError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ClassicWorkflowFailure';
  }
}
const fail = (message) => {
  throw new ClassicWorkflowError(message);
};

const localName = (name) => String(name).split(':').pop();
function attrOf(node, name) {
  for (const [key, value] of Object.entries(node.attrs ?? {})) if (localName(key) === name) return value;
  return undefined;
}
const tag = (node) => `<${node.name}>`;

// Namespaced attributes (x:Key, x:TypeArguments, designer hints) and DisplayName carry no behaviour; any other attribute
// outside the activity's list could, so it is refused.
function checkAttributes(node, allowed) {
  for (const key of Object.keys(node.attrs ?? {}))
    if (!key.includes(':') && key !== 'DisplayName' && !allowed.includes(key))
      unsupported(`${tag(node)} has the attribute ${key}, which is outside the supported subset.`);
}

function checkChildren(node, allowed) {
  for (const child of node.children)
    if (!allowed.includes(localName(child.name)))
      unsupported(`${tag(node)} holds ${tag(child)}, which is outside the supported subset.`);
}

// ---- References

function variableName(text, where) {
  const match = /^\[([A-Za-z_]\w{0,127})\]$/.exec(String(text ?? '').trim());
  if (!match || KEYWORDS.has(match[1])) unsupported(`${where} is not a workflow variable reference.`);
  return match[1];
}

// A value operand: a variable, a Boolean literal, or null.
function operandOf(text, where) {
  const value = String(text ?? '').trim();
  if (value === '[True]') return { literal: true };
  if (value === '[False]') return { literal: false };
  if (value === '[Nothing]' || value === '{x:Null}') return { literal: null };
  return { variable: variableName(value, where) };
}

function entityRefOf(text, where, { id = false } = {}) {
  const match = ENTITY_REF.exec(String(text ?? '').trim());
  if (!match || Boolean(match[3]) !== id)
    unsupported(`${where} is not ${id ? "an entity's Id" : 'an entity'} reference of the supported subset.`);
  const scope = match[1] === 'InputEntities' ? 'input' : 'created';
  if (scope === 'input' && match[2] !== 'primaryEntity' && !RELATED.test(match[2]))
    unsupported(
      `${where} reads InputEntities("${match[2]}"), which is neither the primary entity nor a related entity.`,
    );
  return { scope, key: match[2] };
}

function tableOf(node, where) {
  const table = String(attrOf(node, 'EntityName') ?? '').toLowerCase();
  if (!COLUMN.test(table)) unsupported(`${where} names no table.`);
  return table;
}

function columnOf(node, where) {
  const column = String(attrOf(node, 'Attribute') ?? '').toLowerCase();
  if (!COLUMN.test(column)) unsupported(`${where} names no column.`);
  return column;
}

// The type a ReferenceLiteral inside a TargetType names (directly or inside one InArgument), or null.
function targetTypeOf(node) {
  let container = node;
  for (let level = 0; container && level < 2; level += 1) {
    const literal = container.children.find((child) => localName(child.name) === 'ReferenceLiteral');
    if (literal) {
      const value = attrOf(literal, 'Value');
      return value === undefined ? null : (TYPES.get(value) ?? value);
    }
    container = container.children.find((child) => localName(child.name) === 'InArgument');
  }
  return null;
}

// The comma-separated items of a VB object array: "text" literals ("" escapes a quote) and dotted names.
function objectList(text, where) {
  const match = OBJECT_LIST.exec(String(text ?? '').trim());
  if (!match) unsupported(`${where} is not a literal object array.`);
  const source = match[1];
  const items = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === ' ' || character === ',') cursor += 1;
    else if (character === '"') cursor = readQuoted(source, cursor, items, where);
    else cursor = readName(source, cursor, items, where);
    if (items.length > XAML_LIMITS.parameters) unsupported(`${where} has more than ${XAML_LIMITS.parameters} items.`);
  }
  return items;
}

function readQuoted(source, start, items, where) {
  let text = '';
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] !== '"') text += source[cursor];
    else if (source[cursor + 1] === '"') {
      text += '"';
      cursor += 1;
    } else {
      items.push({ text });
      return cursor + 1;
    }
  }
  return unsupported(`${where} has an unterminated string literal.`);
}

function readName(source, start, items, where) {
  let cursor = start;
  while (cursor < source.length && /[\w.]/.test(source[cursor])) cursor += 1;
  if (cursor === start) unsupported(`${where} has an item outside the supported literal forms.`);
  items.push({ name: source.slice(start, cursor) });
  return cursor;
}

// ---- Literals

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
    (texts, where) => {
      // The condition dialog writes a Yes/No value as "1" or "0" (summary-F6 DATA-04c2).
      const value = { true: true, false: false, 1: true, 0: false }[String(texts[0]).toLowerCase()];
      if (value === undefined) unsupported(`${where}: '${texts[0]}' is not a Boolean literal.`);
      return value;
    },
  ],
  ['String', (texts) => texts[0]],
  ['Integer', (texts, where) => integerOf(texts[0], where)],
  ['OptionSetValue', (texts, where) => integerOf(texts[0], where)],
  ['Decimal', (texts, where) => numberOf(texts[0], where)],
  ['Float', (texts, where) => numberOf(texts[0], where)],
  ['Money', (texts, where) => numberOf(texts[0], where)],
  [
    'DateTime',
    // Only forms that read the same in every time zone: a date (UTC midnight) or a date and time with Z or an offset.
    (texts, where) => {
      const time = ISO_DATE.test(texts[0]) || ISO_DATE_TIME.test(texts[0]) ? Date.parse(texts[0]) : Number.NaN;
      if (Number.isNaN(time)) unsupported(`${where}: '${texts[0]}' is not an ISO 8601 date literal.`);
      return new Date(time).toISOString();
    },
  ],
  [
    'Guid',
    (texts, where) => {
      const match = GUID.exec(texts[0]);
      if (!match) unsupported(`${where}: '${texts[0]}' is not a GUID literal.`);
      return match[1].toLowerCase();
    },
  ],
  [
    'EntityReference',
    (texts, where) => {
      const id = texts.map((text) => GUID.exec(text)?.[1]).find(Boolean);
      const tables = texts.filter((text) => !GUID.test(text) && COLUMN.test(text.toLowerCase()));
      if (!id || !tables.length) unsupported(`${where}: the EntityReference literal names no row id and table.`);
      return { reference: { id: id.toLowerCase(), tables: tables.map((text) => text.toLowerCase()) } };
    },
  ],
]);

// An EntityReference whose row id is a workflow variable (a Guid literal of an earlier expression):
// [EntityReference, "<table>", "<name>", <variable>, "Lookup"].
function referenceFromVariable(rest, where) {
  const names = rest.filter((item) => item.text === undefined).map((item) => item.name);
  const texts = rest.filter((item) => item.text !== undefined).map((item) => item.text);
  const table = texts.find((text) => COLUMN.test(text.toLowerCase()) && text !== 'Lookup');
  if (names.length !== 1 || !IDENTIFIER.test(names[0]) || KEYWORDS.has(names[0]) || !table)
    unsupported(`${where}: the EntityReference names no table and row id variable.`);
  const id = context?.guids.get(names[0]) ?? null;
  if (id) noteReference(table.toLowerCase(), id);
  return { reference: { idVariable: names[0], tables: [table.toLowerCase()] } };
}

// A lookup literal activation checks: its table, row id and the designer steps around it (innermost first).
function noteReference(table, id) {
  context?.references.push({ table, id, steps: [...context.ancestors].reverse() });
}

function crmLiteral(items, where) {
  const [head, ...rest] = items;
  if (!head?.name?.startsWith(PROPERTY_TYPE)) unsupported(`${where} names no WorkflowPropertyType.`);
  const type = head.name.slice(PROPERTY_TYPE.length);
  const convert = LITERALS.get(type);
  if (!convert) unsupported(`${where}: WorkflowPropertyType.${type} is outside the supported subset.`);
  if (type === 'EntityReference' && rest.some((item) => item.text === undefined))
    return referenceFromVariable(rest, where);
  if (rest.some((item) => item.text === undefined))
    unsupported(`${where} mixes variables into a CreateCrmType literal.`);
  const texts = rest.map((item) => item.text);
  if (!texts.length) return { literal: null };
  const value = convert(texts, where);
  if (value?.reference) noteReference(value.reference.tables[0], value.reference.id);
  return value?.reference ? value : { literal: value };
}

// ---- Activity references (Microsoft.Crm.Workflow.Activities)

function keyedChildren(container, map, owner) {
  for (const child of container.children) {
    const key = attrOf(child, 'Key');
    if (!key || map.has(key)) unsupported(`${owner} has an unkeyed or repeated argument.`);
    map.set(key, child);
  }
}

function referenceParts(node, label, allowedArguments, allowedProperties) {
  checkAttributes(node, ['AssemblyQualifiedName']);
  const args = new Map();
  const props = new Map();
  for (const child of node.children) {
    const name = localName(child.name);
    if (name === 'ActivityReference.Arguments') keyedChildren(child, args, label);
    else if (name === 'ActivityReference.Properties') keyedChildren(child, props, label);
    else unsupported(`${label} holds ${tag(child)}, which is outside the supported subset.`);
  }
  for (const [map, allowed] of [
    [args, allowedArguments],
    [props, allowedProperties],
  ])
    for (const key of map.keys())
      if (!allowed.includes(key))
        unsupported(`${label} has the argument ${key}, which is outside the supported subset.`);
  return { args, props };
}

const argumentText = (node) => (node && localName(node.name) !== 'Null' ? node.text.trim() : null);

// A variable's Default by its type: x:Boolean True/False, a number for x:Int32/x:Int64/x:Decimal/x:Double, [Nothing] null,
// else the text (the designer writes GUID strings and language codes this way).
function defaultOf(item, name) {
  const fallback = attrOf(item, 'Default');
  if (fallback === undefined || fallback === '[Nothing]') return null;
  if (fallback.length > MAX_DEFAULT) unsupported(`The default of workflow variable ${name} is too long.`);
  const type = attrOf(item, 'TypeArguments');
  if (type === 'x:Boolean') {
    if (fallback !== 'True' && fallback !== 'False')
      unsupported(`The default of workflow variable ${name} is not True or False.`);
    return fallback === 'True';
  }
  if (['x:Int32', 'x:Int64', 'x:Decimal', 'x:Double'].includes(type)) return numberOf(fallback, `Variable ${name}`);
  // The designer's Timeout wait starts its last-execution variable at DateTime.MinValue (summary-F6 DATA-04c2).
  if (fallback === '[System.DateTime.MinValue]') return DATE_MIN_VALUE;
  if (/^\[.*\]$/s.test(fallback)) unsupported(`The default of workflow variable ${name} is an expression.`);
  return fallback;
}

// An XrmTimeSpan literal default (the designer's offset of a Timeout wait, "{2 Minutes After Due}"): its parts.
function timeSpanDefaultOf(item, name) {
  const holder = item.children.find((child) => localName(child.name) === 'Variable.Default');
  const literal = holder?.children[0];
  const span = literal?.children[0];
  if (
    item.children.length !== 1 ||
    localName(literal?.name ?? '') !== 'Literal' ||
    localName(span?.name ?? '') !== 'XrmTimeSpan' ||
    (literal?.children.length ?? 0) !== 1
  )
    unsupported(`The default of workflow variable ${name} is not an XrmTimeSpan literal.`);
  checkAttributes(span, TIME_SPAN_PARTS);
  return {
    timeSpan: Object.fromEntries(
      TIME_SPAN_PARTS.map((part) => [
        part.toLowerCase(),
        integerOf(String(attrOf(span, part) ?? '0'), `Variable ${name} ${part}`),
      ]),
    ),
  };
}

function variablesOf(collection) {
  const variables = [];
  for (const item of collection?.children ?? []) {
    if (localName(item.name) !== 'Variable') unsupported(`${tag(item)} is not a workflow variable.`);
    const name = attrOf(item, 'Name');
    if (!IDENTIFIER.test(name ?? '') || KEYWORDS.has(name)) unsupported('A workflow variable has no valid name.');
    const timeSpan = String(attrOf(item, 'TypeArguments') ?? '').endsWith(':XrmTimeSpan');
    variables.push({ name, value: timeSpan ? timeSpanDefaultOf(item, name) : defaultOf(item, name) });
  }
  return variables;
}

function collectionSteps(collection, depth) {
  if (!collection) return [];
  if (localName(collection.name) !== 'Collection') unsupported(`${tag(collection)} is not an activity collection.`);
  return compileSteps(collection.children, depth + 1);
}

function compileComposite(parts, depth) {
  return {
    kind: 'sequence',
    variables: variablesOf(parts.props.get('Variables')),
    steps: collectionSteps(parts.props.get('Activities'), depth),
  };
}

function compileBranchBody(node, depth) {
  if (!node || localName(node.name) === 'Null') return null;
  const step = compileActivity(node, depth + 1);
  // The designer's Timeout wait branch has a non-blocking Postpone to its due time as its Else (summary-F6 DATA-04c2):
  // it names the time the wait wakes; the branch's own condition decides.
  // The Web API accepts and activates this designer form (DATA-04c2 probe), unlike the Postpone forms F6 authored by hand.
  if (step.kind === 'postpone' && !step.block) {
    const index = context?.webApi.lastIndexOf('Postpone') ?? -1;
    if (index >= 0) context.webApi.splice(index, 1);
    return { kind: 'sequence', variables: [], steps: [step], composite: true };
  }
  if (step.kind !== 'sequence' || step.composite !== true)
    unsupported('A ConditionBranch Then or Else is not a Composite activity.');
  return step;
}

const REFERENCES = new Map([
  [
    'ConditionSequence',
    (node, label, depth) => {
      const parts = referenceParts(node, label, ['Wait'], ['Variables', 'Activities', 'ContainsElseBranch']);
      const wait = argumentText(parts.args.get('Wait')) ?? 'False';
      if (wait !== 'False' && wait !== 'True') unsupported(`${label} Wait is not True or False.`);
      const compiled = compileComposite(parts, depth);
      if (wait === 'True' && !compiled.steps.some((step) => step.kind === 'branch'))
        unsupported(`${label} waits without a wait branch.`);
      if (wait !== 'True') return { ...compiled, kind: 'choice' };
      // The primary row columns the wait's conditions read: only a write of one of them wakes it (summary-F6 OPS-01d).
      const columns = compiled.steps
        .filter((step) => step.kind === 'get' && step.entity.scope === 'input' && step.entity.key === 'primaryEntity')
        .map((step) => step.attribute);
      return { ...compiled, kind: 'wait', columns: [...new Set(columns)] };
    },
  ],
  [
    'Composite',
    (node, label, depth) => ({
      ...compileComposite(referenceParts(node, label, [], ['Variables', 'Activities']), depth),
      composite: true,
    }),
  ],
  [
    'ConditionBranch',
    (node, label, depth) => {
      const parts = referenceParts(node, label, ['Condition'], ['Then', 'Else', 'Description']);
      return {
        kind: 'branch',
        condition: operandOf(argumentText(parts.args.get('Condition')), `${label} Condition`),
        then: compileBranchBody(parts.props.get('Then'), depth), // NOSONAR: `then` is a domain property, not a thenable
        else: compileBranchBody(parts.props.get('Else'), depth),
      };
    },
  ],
  ['EvaluateExpression', (node, label) => compileExpression(node, label)],
  [
    'EvaluateCondition',
    (node, label) => {
      const parts = referenceParts(node, label, ['ConditionOperator', 'Parameters', 'Operand', 'Result'], []);
      const operator = argumentText(parts.args.get('ConditionOperator'));
      if (!CONDITIONS.has(operator))
        unsupported(`${label}: condition operator ${operator} is outside the supported subset.`);
      const parameters = argumentText(parts.args.get('Parameters'));
      const items = parameters === null ? [] : objectList(parameters, `${label} Parameters`);
      if (items.some((item) => !IDENTIFIER.test(item.name ?? '')))
        unsupported(`${label}: condition parameters must be workflow variables.`);
      return {
        kind: 'condition',
        operator,
        operand: operandOf(argumentText(parts.args.get('Operand')), `${label} Operand`),
        parameters: items.map((item) => ({ variable: item.name })),
        result: variableName(argumentText(parts.args.get('Result')), `${label} Result`),
      };
    },
  ],
  [
    'EvaluateLogicalCondition',
    (node, label) => {
      const parts = referenceParts(node, label, ['LogicalOperator', 'LeftOperand', 'RightOperand', 'Result'], []);
      const operator = argumentText(parts.args.get('LogicalOperator'));
      if (operator !== 'And' && operator !== 'Or')
        unsupported(`${label}: logical operator ${operator} is not And or Or.`);
      return {
        kind: 'logical',
        operator,
        left: operandOf(argumentText(parts.args.get('LeftOperand')), `${label} LeftOperand`),
        right: operandOf(argumentText(parts.args.get('RightOperand')), `${label} RightOperand`),
        result: variableName(argumentText(parts.args.get('Result')), `${label} Result`),
      };
    },
  ],
  [
    'ConvertCrmXrmTypes',
    (node, label) => {
      const parts = referenceParts(node, label, ['Value', 'TargetType', 'Result'], []);
      return {
        kind: 'convert',
        value: operandOf(argumentText(parts.args.get('Value')), `${label} Value`),
        type: targetTypeOf(parts.args.get('TargetType')),
        result: variableName(argumentText(parts.args.get('Result')), `${label} Result`),
      };
    },
  ],
]);

// Workflow variable names of an expression's parameters; anything else (a literal, a keyword) is outside the subset.
const variableItems = (items) =>
  items.every((item) => IDENTIFIER.test(item.name ?? '') && !KEYWORDS.has(item.name))
    ? items.map((item) => item.name)
    : null;

// The expression operators beyond CreateCrmType, each answering its compiled step.
const EXPRESSIONS = new Map([
  // RetrieveLastExecutionTime (the designer's Timeout wait): the time the run last executed; Mirage reads its own clock.
  [
    'RetrieveLastExecutionTime',
    ({ items, label, result }) => {
      if (items.length !== 1 || !variableItems(items))
        unsupported(`${label}: RetrieveLastExecutionTime takes one workflow variable.`);
      return { kind: 'now', result };
    },
  ],
  // Add with a DateTime target type is a date plus the designer's XrmTimeSpan offset (summary-F6 DATA-04c2); otherwise
  // it joins its operands as text (the designer's dynamic text values; summary-F6 OPS-01d).
  [
    'Add',
    ({ items, label, result, parts }) => {
      const names = variableItems(items);
      if (targetTypeOf(parts.args.get('TargetType')) === 'datetime') {
        if (items.length !== 2 || !names) unsupported(`${label}: a date Add takes a date and a time span variable.`);
        return { kind: 'dateAdd', date: names[0], span: names[1], result };
      }
      if (!items.length || !names) unsupported(`${label}: Add takes workflow variables.`);
      return { kind: 'add', sources: names, result };
    },
  ],
  // RetrieveCurrentTime: the run's current time. The Web API accepts it only with xml:space="preserve" on its empty
  // Parameters, as the designer writes it (summary-F6 OPS-01d).
  [
    'RetrieveCurrentTime',
    ({ items, label, result, parameters }) => {
      if (items.length) unsupported(`${label}: RetrieveCurrentTime takes no parameters.`);
      if (attrOf(parameters, 'space') !== 'preserve')
        context?.webApi.push('RetrieveCurrentTime parameters without xml:space="preserve"');
      return { kind: 'now', result };
    },
  ],
  [
    'SelectFirstNonNull',
    ({ items, label, result }) => {
      const names = variableItems(items);
      if (!items.length || !names) unsupported(`${label}: SelectFirstNonNull takes workflow variables.`);
      return { kind: 'first', sources: names, result };
    },
  ],
]);

function compileExpression(node, label) {
  const parts = referenceParts(node, label, ['ExpressionOperator', 'Parameters', 'TargetType', 'Result'], []);
  const operator = argumentText(parts.args.get('ExpressionOperator'));
  const result = variableName(argumentText(parts.args.get('Result')), `${label} Result`);
  const parameters = parts.args.get('Parameters');
  const items = objectList(argumentText(parameters), `${label} Parameters`);
  if (operator === 'CreateCrmType') {
    const literal = crmLiteral(items, `${label} Parameters`);
    if (items[0]?.name === `${PROPERTY_TYPE}Guid` && typeof literal.literal === 'string')
      context?.guids.set(result, literal.literal);
    return { kind: 'expression', ...literal, result };
  }
  const compile = EXPRESSIONS.get(operator);
  if (!compile) unsupported(`${label}: expression operator ${operator} is outside the supported subset.`);
  return compile({ items, label, result, parts, parameters });
}

// ---- Activities

function compileActivityReference(node, depth) {
  const qualified = String(attrOf(node, 'AssemblyQualifiedName') ?? '')
    .split(',')[0]
    .trim();
  const short = qualified.startsWith(ACTIVITY_NAMESPACE) ? qualified.slice(ACTIVITY_NAMESPACE.length) : null;
  const compile = short === null ? null : REFERENCES.get(short);
  if (!compile)
    unsupported(
      `The classic workflow uses activity ${qualified || '(unnamed)'}, which is outside the supported subset.`,
    );
  return compile(node, `Activity ${short}`, depth);
}

function compileSequence(node, depth) {
  checkAttributes(node, []);
  const variables = [];
  const body = [];
  for (const child of node.children) {
    if (localName(child.name) === 'Sequence.Variables') variables.push(...variablesOf(child));
    else body.push(child);
  }
  return { kind: 'sequence', variables, steps: compileSteps(body, depth + 1) };
}

function compileGet(node) {
  checkAttributes(node, ['Attribute', 'Entity', 'EntityName', 'Value']);
  checkChildren(node, ['GetEntityProperty.TargetType']);
  return {
    kind: 'get',
    entity: entityRefOf(attrOf(node, 'Entity'), 'GetEntityProperty Entity'),
    table: tableOf(node, 'GetEntityProperty'),
    attribute: columnOf(node, 'GetEntityProperty'),
    type: targetTypeOf(node.children[0]),
    result: variableName(attrOf(node, 'Value'), 'GetEntityProperty Value'),
  };
}

function compileSet(node) {
  checkAttributes(node, ['Attribute', 'Entity', 'EntityName', 'Value']);
  checkChildren(node, ['SetEntityProperty.TargetType']);
  return {
    kind: 'set',
    entity: entityRefOf(attrOf(node, 'Entity'), 'SetEntityProperty Entity'),
    table: tableOf(node, 'SetEntityProperty'),
    attribute: columnOf(node, 'SetEntityProperty'),
    value: operandOf(attrOf(node, 'Value') ?? '{x:Null}', 'SetEntityProperty Value'),
  };
}

function compileAssign(node) {
  checkAttributes(node, ['To', 'Value', 'TypeArguments']);
  checkChildren(node, []);
  const to = String(attrOf(node, 'To') ?? '').trim();
  const value = String(attrOf(node, 'Value') ?? '').trim();
  const target = /^\[([A-Za-z_]\w{0,127})\]$/.exec(to)?.[1];
  const orMax = OR_MAX.exec(value);
  if (orMax && target && orMax[1] === target && orMax[2] === target) return { kind: 'orMax', variable: target };
  const pastDue = PAST_DUE.exec(value);
  if (pastDue && target) return { kind: 'pastDue', due: pastDue[1], result: target };
  const created = NEW_ENTITY.exec(value);
  if (created) return { kind: 'new', to: entityRefOf(to, 'Assign To'), table: created[1].toLowerCase() };
  if (to.endsWith('.Id]'))
    return {
      kind: 'id',
      to: entityRefOf(to, 'Assign To', { id: true }),
      from: value === '[Guid.Empty]' ? null : entityRefOf(value, 'Assign Value', { id: true }),
    };
  return { kind: 'copy', to: entityRefOf(to, 'Assign To'), from: entityRefOf(value, 'Assign Value') };
}

function compileWrite(kind) {
  return (node) => {
    checkAttributes(node, kind === 'create' ? ['Entity', 'EntityName', 'EntityId'] : ['Entity', 'EntityName']);
    checkChildren(node, []);
    const entity = entityRefOf(attrOf(node, 'Entity'), `${localName(node.name)} Entity`);
    if (entity.scope !== 'created') unsupported(`${tag(node)} writes an entity that no earlier step built.`);
    const id = attrOf(node, 'EntityId');
    return {
      kind,
      entity,
      table: tableOf(node, localName(node.name)),
      result: id === undefined || id === '{x:Null}' ? null : variableName(id, `${localName(node.name)} EntityId`),
    };
  };
}

function optionSetOf(node, where) {
  const argument = node?.children[0];
  const literal = argument?.children[0];
  const option = literal?.children[0];
  if (
    localName(argument?.name ?? '') !== 'InArgument' ||
    localName(literal?.name ?? '') !== 'ReferenceLiteral' ||
    localName(option?.name ?? '') !== 'OptionSetValue'
  )
    unsupported(`${where} is not a literal OptionSetValue.`);
  return integerOf(String(attrOf(option, 'Value') ?? ''), where);
}

function compileSetState(node) {
  checkAttributes(node, ['Entity', 'EntityId', 'EntityName']);
  checkChildren(node, ['SetState.State', 'SetState.Status']);
  const part = (name) => node.children.find((child) => localName(child.name) === name);
  return {
    kind: 'state',
    entity: entityRefOf(attrOf(node, 'EntityId'), 'SetState EntityId', { id: true }),
    table: tableOf(node, 'SetState'),
    state: optionSetOf(part('SetState.State'), 'SetState State'),
    status: optionSetOf(part('SetState.Status'), 'SetState Status'),
  };
}

// Stop workflow: the designer's form (OperationStatus in a one-argument exception, Reason [DirectCast(<variable>, String)]),
// or the status and message variable both in the exception.
function compileTerminate(node) {
  checkAttributes(node, ['Exception', 'Reason']);
  checkChildren(node, []);
  const exception = String(attrOf(node, 'Exception') ?? '').trim();
  const both = TERMINATE.exec(exception);
  const status = both?.[1] ?? TERMINATE_STATUS.exec(exception)?.[1];
  const reason = REASON.exec(String(attrOf(node, 'Reason') ?? '').trim());
  const variable = both?.[2] ?? reason?.[1] ?? reason?.[2];
  if ((status !== 'Succeeded' && status !== 'Canceled') || !variable)
    unsupported('TerminateWorkflow is not a Stop workflow step with status Succeeded or Canceled.');
  return { kind: 'stop', status: status.toLowerCase(), reason: { variable } };
}

// Postpone (SDK Microsoft.Xrm.Sdk.Workflow.Activities.Postpone): PostponeUntil, the time the run resumes, and BlockExecution,
// whether it suspends; each as an attribute or a property element holding one InArgument.
function compilePostpone(node) {
  checkAttributes(node, ['BlockExecution', 'PostponeUntil', 'DisplayName']);
  const property = (name) => {
    const element = node.children.find((child) => localName(child.name) === `Postpone.${name}`);
    if (!element) return attrOf(node, name);
    const inner = element.children.length === 1 ? element.children[0] : null;
    if (!inner || localName(inner.name) !== 'InArgument') unsupported(`Postpone.${name} holds no single InArgument.`);
    return inner.text;
  };
  for (const child of node.children)
    if (!['Postpone.BlockExecution', 'Postpone.PostponeUntil'].includes(localName(child.name)))
      unsupported(`Postpone holds ${tag(child)}, which is outside the supported subset.`);
  const block = String(property('BlockExecution') ?? 'True').trim();
  if (!['True', 'False', '[True]', '[False]'].includes(block))
    unsupported('Postpone BlockExecution is not True or False.');
  const until = property('PostponeUntil');
  if (until === undefined || until === null) unsupported('Postpone has no PostponeUntil.');
  // Every Postpone form tried was refused at Web API create (summary-F6 OPS-01d); Solution sources may still carry one.
  context?.webApi.push('Postpone');
  // The designer's Timeout wait writes the due time as [DirectCast(<variable>, System.DateTime)] (summary-F6 DATA-04c2).
  const cast = /^\[DirectCast\(([A-Za-z_]\w{0,127}), System\.DateTime\)\]$/.exec(String(until).trim());
  return {
    kind: 'postpone',
    block: block.replace(/[[\]]/g, '') === 'True',
    until: cast
      ? { variable: variableName(`[${cast[1]}]`, 'Postpone PostponeUntil') }
      : operandOf(until, 'Postpone PostponeUntil'),
  };
}

const ACTIVITIES = new Map([
  ['Sequence', compileSequence],
  ['ActivityReference', compileActivityReference],
  ['GetEntityProperty', compileGet],
  ['SetEntityProperty', compileSet],
  ['Assign', compileAssign],
  ['UpdateEntity', compileWrite('update')],
  ['CreateEntity', compileWrite('create')],
  ['SetState', compileSetState],
  ['TerminateWorkflow', compileTerminate],
  ['Persist', () => null],
  ['Postpone', compilePostpone],
]);

// The designer step a node is ({ name, number } from its DisplayName), or null. A Composite repeats its branch's name.
function stepOf(node) {
  const match = STEP_NAME.exec(String(attrOf(node, 'DisplayName') ?? ''));
  if (!match) return null;
  const composite = String(attrOf(node, 'AssemblyQualifiedName') ?? '').startsWith(`${ACTIVITY_NAMESPACE}Composite,`);
  return composite ? null : { name: `${match[1]}${match[2]}`, number: Number(match[2]) };
}

function compileActivity(node, depth) {
  if (depth >= XAML_LIMITS.depth)
    unsupported(`The classic workflow nests deeper than ${XAML_LIMITS.depth} activities.`);
  const compile = ACTIVITIES.get(localName(node.name));
  if (!compile) unsupported(`The classic workflow uses ${tag(node)}, which is outside the supported subset.`);
  const step = stepOf(node);
  if (step) context?.ancestors.push(step.name);
  try {
    const compiled = compile(node, depth);
    return compiled && step ? { ...compiled, step } : compiled;
  } finally {
    if (step) context?.ancestors.pop();
  }
}

function compileSteps(nodes, depth) {
  const steps = [];
  for (const node of nodes) {
    const step = compileActivity(node, depth);
    if (step) steps.push(step);
  }
  return steps;
}

function countElements(root) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    count += 1;
    if (count > XAML_LIMITS.elements)
      unsupported(`The classic workflow XAML has more than ${XAML_LIMITS.elements} elements.`);
    for (const child of node.children) stack.push(child);
  }
}

// The Activity root: x:Members, property elements and VisualBasic settings carry no steps; exactly one Workflow holds them.
function workflowBody(root) {
  if (localName(root.name) !== 'Activity')
    unsupported(`The classic workflow XAML root is ${tag(root)}, not <Activity>.`);
  const bodies = [];
  for (const child of root.children) {
    const name = localName(child.name);
    if (name === 'Workflow') bodies.push(child);
    else if (name !== 'Members' && !name.includes('.'))
      unsupported(`The classic workflow XAML root holds ${tag(child)}, which is outside the supported subset.`);
  }
  if (bodies.length !== 1) unsupported('The classic workflow XAML holds no single Workflow activity.');
  checkAttributes(bodies[0], []);
  return bodies[0];
}

/**
 * Parses classic workflow designer XAML into { program } (a frozen step model) or { unsupported: reason }. Input is untrusted:
 * size, element count and nesting are bounded (XAML_LIMITS), and only the literal forms of the supported subset are read.
 */
export function parseClassicWorkflow(xaml) {
  if (typeof xaml !== 'string' || !xaml.trim()) return { unsupported: 'The classic workflow has no XAML.' };
  if (xaml.length > XAML_LIMITS.length)
    return { unsupported: `The classic workflow XAML is longer than ${XAML_LIMITS.length} characters.` };
  try {
    const root = parseSolutionXml(xaml.replace(/^\uFEFF/, ''));
    countElements(root);
    context = newContext();
    context.ancestors.push('WorkflowStep0');
    const body = workflowBody(root);
    // mxswa:Workflow.Variables declares the workflow's own variables (summary-F6 OPS-01d).
    const declared = body.children.filter((child) => localName(child.name) === 'Workflow.Variables');
    const variables = declared.flatMap((child) => variablesOf(child));
    const steps = compileSteps(
      body.children.filter((child) => localName(child.name) !== 'Workflow.Variables'),
      0,
    );
    const waitColumns = [...new Set(collect(steps, (step) => (step.kind === 'wait' ? step.columns : [])))];
    const program = {
      steps,
      variables,
      waits: hasWait(steps),
      waitColumns,
      references: context.references,
      webApi: [...new Set(context.webApi)],
    };
    return { program: deepFreeze(program) };
  } catch (error) {
    return {
      unsupported:
        error instanceof Unsupported ? error.message : `The classic workflow XAML is not readable: ${error.message}`,
    };
  } finally {
    context = null;
  }
}

// Every value pick(step) answers for the steps of a tree, flattened.
function collect(steps, pick) {
  const out = [];
  const stack = [...steps];
  while (stack.length) {
    const step = stack.pop();
    if (!step) continue;
    out.push(...pick(step));
    stack.push(...(step.steps ?? []), step.then, step.else);
  }
  return out;
}

// Whether a step list holds a wait condition or a Postpone anywhere (a real-time workflow cannot wait).
function hasWait(steps) {
  const stack = [...steps];
  while (stack.length) {
    const step = stack.pop();
    if (!step) continue;
    if (step.kind === 'wait' || step.kind === 'postpone') return true;
    stack.push(...(step.steps ?? []), step.then, step.else);
  }
  return false;
}

function deepFreeze(value) {
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    Object.freeze(item);
    for (const child of Object.values(item)) if (child !== null && typeof child === 'object') stack.push(child);
  }
  return value;
}

// ---- Interpreter

// The workflow log of a run (summary-F6 OPS-01d): one entry per designer step it executed, Step_<number>. A condition
// (ConditionStep, WaitStep) is logged when it is evaluated; a branch when the body it ran completed; any other step when
// it completed. A step that fails is logged with status 3 and error code 0x80044331 (-2147204303), and so is every
// condition around it; a Stop is logged completed. Message: '' for conditions, branches and Stop, null for other steps.
const LOGGED = 2;
const FAILED = 3;
export const FAILED_STEP_CODE = -2147204303;
const logEntry = (step, message) => ({
  stepname: `Step_${step.number}`,
  activityname: `${step.name}_step`,
  status: LOGGED,
  errorcode: null,
  message,
});
function markFailed(entry, error) {
  Object.assign(entry, { status: FAILED, errorcode: FAILED_STEP_CODE, message: String(error?.message ?? error) });
}
// The first failure of a run: where it resumes (the current step path) and the log rows it marks failed (the failing
// step's own, when it has one, and every open condition around it).
function noteFailure(state, error, entry = null) {
  if (state.failure) return;
  state.failure = { error, path: [...state.path] };
  for (const condition of state.conditions) markFailed(condition, error);
  if (entry) {
    markFailed(entry, error);
    state.logs.push(entry);
  }
}

const clone = (value) => (value === null || value === undefined ? null : structuredClone(value));
const empty = (value) => value === null || value === undefined || value === '';
const idOfValue = (value) => String(value?.id ?? value ?? '').toLowerCase();

function entityOf(logicalName, id, row) {
  return { logicalName, id: id ? String(id).toLowerCase() : null, attributes: clone(row) ?? {}, changed: new Set() };
}
const copyEntity = (entity) =>
  entity && { ...entity, attributes: clone(entity.attributes), changed: new Set(entity.changed) };

function scopeOf(state, ref) {
  return ref.scope === 'input' ? state.input : state.created;
}

// A related entity (related_<lookup>#<table>) is the row the primary row's lookup names, read when first referenced.
async function resolveEntity(state, ref) {
  const scope = scopeOf(state, ref);
  if (scope.has(ref.key)) return scope.get(ref.key);
  if (ref.scope === 'created') return null;
  const [, lookup, table] = RELATED.exec(ref.key);
  const primary = state.input.get('primaryEntity');
  const id = idOfValue(primary?.attributes?.[lookup.toLowerCase()]);
  const row = id ? await state.host.read(table.toLowerCase(), id) : null;
  const entity = row ? entityOf(table.toLowerCase(), id, row) : null;
  scope.set(ref.key, entity);
  return entity;
}

const valueOf = (state, operand) =>
  'literal' in operand ? operand.literal : (state.vars.get(operand.variable) ?? null);

function checkTable(entity, table, where) {
  if (entity.logicalName !== table)
    fail(`${where} names table ${table}, but the entity it addresses is a ${entity.logicalName} row.`);
}

// Every entity variable that holds the written row sees the stored values after the write.
function refresh(state, logicalName, id, row) {
  for (const scope of [state.input, state.created])
    for (const entity of scope.values())
      if (entity && entity.logicalName === logicalName && entity.id === id) {
        entity.attributes = clone(row) ?? {};
        entity.changed = new Set();
      }
}

const changedData = (entity) =>
  Object.fromEntries([...entity.changed].map((name) => [name, clone(entity.attributes[name])]));

const comparable = (value) => {
  if (empty(value)) return null;
  if (typeof value === 'object') return idOfValue(value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)))
    return Date.parse(value);
  return typeof value === 'string' ? value.toLowerCase() : value;
};
const text = (value) => (empty(value) ? '' : String(comparable(value)));
const same = (left, right) => comparable(left) !== null && comparable(left) === comparable(right);
const ordered = (left, right, test) => {
  const a = comparable(left);
  const b = comparable(right);
  return a !== null && b !== null && typeof a === typeof b && test(a, b);
};

const CONDITION_TESTS = new Map([
  ['Equal', (operand, values) => values.some((value) => same(operand, value))],
  ['NotEqual', (operand, values) => !values.some((value) => same(operand, value))],
  ['Null', (operand) => empty(operand)],
  ['NotNull', (operand) => !empty(operand)],
  ['GreaterThan', (operand, [value]) => ordered(operand, value, (a, b) => a > b)],
  ['GreaterEqual', (operand, [value]) => ordered(operand, value, (a, b) => a >= b)],
  ['LessThan', (operand, [value]) => ordered(operand, value, (a, b) => a < b)],
  ['LessEqual', (operand, [value]) => ordered(operand, value, (a, b) => a <= b)],
  ['BeginsWith', (operand, [value]) => !empty(operand) && text(operand).startsWith(text(value))],
  ['DoesNotBeginWith', (operand, [value]) => empty(operand) || !text(operand).startsWith(text(value))],
  ['EndsWith', (operand, [value]) => !empty(operand) && text(operand).endsWith(text(value))],
  ['DoesNotEndWith', (operand, [value]) => empty(operand) || !text(operand).endsWith(text(value))],
  ['Contains', (operand, [value]) => !empty(operand) && text(operand).includes(text(value))],
  ['DoesNotContain', (operand, [value]) => empty(operand) || !text(operand).includes(text(value))],
]);

function convertValue(value, type) {
  if (type !== 'string' || empty(value)) return clone(value);
  if (typeof value === 'object') return idOfValue(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

async function runGet(state, step) {
  const entity = await resolveEntity(state, step.entity);
  let value = null;
  if (entity) {
    checkTable(entity, step.table, 'GetEntityProperty');
    if (step.attribute === state.host.idColumn(entity.logicalName))
      value = step.type === 'reference' ? { id: entity.id, logical_name: entity.logicalName } : entity.id;
    else value = clone(entity.attributes[step.attribute]);
  }
  state.vars.set(step.result, value);
}

async function runSet(state, step) {
  const entity = await resolveEntity(state, step.entity);
  if (!entity) fail(`SetEntityProperty sets ${step.attribute} on an entity no earlier step built.`);
  checkTable(entity, step.table, 'SetEntityProperty');
  entity.attributes[step.attribute] = clone(valueOf(state, step.value));
  entity.changed.add(step.attribute);
}

async function runWrite(state, step) {
  const entity = await resolveEntity(state, step.entity);
  if (!entity) fail(`${step.kind === 'create' ? 'CreateEntity' : 'UpdateEntity'} has no entity to write.`);
  checkTable(entity, step.table, step.kind === 'create' ? 'CreateEntity' : 'UpdateEntity');
  const data = changedData(entity);
  if (step.kind === 'create') {
    const row = await state.host.create(step.table, data);
    entity.id = idOfValue(row?.[state.host.idColumn(step.table)]);
    entity.attributes = clone(row) ?? {};
    entity.changed = new Set();
    if (step.result) state.vars.set(step.result, entity.id);
    state.host.trace(`CreateEntity: created ${step.table}(${entity.id}).`);
    return;
  }
  if (!entity.id) fail(`UpdateEntity has no ${step.table} row id to update.`);
  const row = await state.host.update(step.table, entity.id, data);
  refresh(state, step.table, entity.id, row);
  state.host.trace(
    `UpdateEntity: updated ${step.table}(${entity.id}): ${Object.keys(data).join(', ') || '(no columns)'}.`,
  );
}

async function runState(state, step) {
  const entity = await resolveEntity(state, step.entity);
  if (!entity?.id) fail(`SetState has no ${step.table} row id.`);
  checkTable(entity, step.table, 'SetState');
  const row = await state.host.update(step.table, entity.id, { statecode: step.state, statuscode: step.status });
  refresh(state, step.table, entity.id, row);
  state.host.trace(`SetState: ${step.table}(${entity.id}) to state ${step.state}, status ${step.status}.`);
}

async function runAssign(state, step) {
  const scope = scopeOf(state, step.to);
  if (step.kind === 'new') {
    scope.set(step.to.key, entityOf(step.table, null, null));
    return;
  }
  if (step.kind === 'copy') {
    scope.set(step.to.key, copyEntity(await resolveEntity(state, step.from)));
    return;
  }
  const target = await resolveEntity(state, step.to);
  if (!target) fail(`Assign sets the Id of an entity no earlier step built.`);
  const source = step.from ? await resolveEntity(state, step.from) : null;
  target.id = source?.id ?? null;
}

// A resumed run walks back to the step that suspended along state.resume (one index or branch side per level); the steps
// before it on that path are not run again and their containers keep the restored variables.
const resuming = (state) => state.resume.length > 0;
const halted = (state) => Boolean(state.stop || state.suspended);

// Runs `work` with `segment` on the current step path (what a suspension or a failure records). A failure is recorded
// at the innermost position that fails, unless a designer action step around it records it at that step (runStep).
async function at(state, segment, work) {
  state.path.push(segment);
  try {
    return await work();
  } catch (error) {
    if (!state.action) noteFailure(state, error);
    throw error;
  } finally {
    state.path.pop();
  }
}

async function runSequence(state, step) {
  const resumed = resuming(state);
  const from = resumed ? state.resume.shift() : 0;
  if (!resumed) for (const variable of step.variables ?? []) state.vars.set(variable.name, variable.value);
  for (let index = from; index < step.steps.length; index++) {
    if (halted(state)) return;
    await at(state, index, () => runStep(state, step.steps[index]));
  }
}

// A logged branch: when the body it ran completes (not stopped, not suspended inside it).
function logBranch(state, step) {
  if (step.step && !halted(state)) state.logs.push(logEntry(step.step, ''));
}

// A branch that runs one of its bodies answers true.
async function runBranch(state, step) {
  if (resuming(state)) {
    const side = state.resume.shift();
    await at(state, side, () => runSequence(state, side === 'then' ? step.then : step.else));
    logBranch(state, step);
    return true;
  }
  const holds = valueOf(state, step.condition) === true;
  const body = holds ? step.then : step.else;
  if (body) {
    await at(state, holds ? 'then' : 'else', () => runSequence(state, body));
    logBranch(state, step);
  }
  return holds || Boolean(body);
}

// A logged condition: its entry is written when it is evaluated and stays open while its body runs, so a failure inside
// marks it failed too. A condition passed on the way back to a resumed step was logged by the earlier part of the run.
async function withCondition(state, step, work, { log = true } = {}) {
  const entry = step.step && log ? logEntry(step.step, '') : null;
  if (entry) state.logs.push(entry);
  if (entry) state.conditions.push(entry);
  try {
    return await work();
  } finally {
    if (entry) state.conditions.pop();
  }
}

async function runChoice(state, step) {
  const resumed = resuming(state);
  return withCondition(
    state,
    step,
    async () => {
      let from = 0,
        matched = false;
      if (resumed) {
        from = state.resume.shift();
        matched = step.steps[from]?.kind === 'branch';
        if (matched) await at(state, from, () => runBranch(state, step.steps[from]));
        from += matched ? 1 : 0;
      } else for (const variable of step.variables) state.vars.set(variable.name, variable.value);
      for (let index = from; index < step.steps.length; index++) {
        if (halted(state)) return;
        const item = step.steps[index];
        if (item.kind !== 'branch') await at(state, index, () => runStep(state, item));
        else if (!matched) matched = await at(state, index, () => runBranch(state, item));
      }
    },
    { log: !resumed },
  );
}

// A wait: its conditions are evaluated (again on each resume, against the record as it is then); the first wait branch whose
// condition holds runs, and when none holds the run suspends here. A resume inside a branch's body continues that body.
async function runWait(state, step) {
  if (resuming(state) && step.steps[state.resume[0]]?.kind === 'branch') {
    const index = state.resume.shift();
    await withCondition(state, step, () => at(state, index, () => runBranch(state, step.steps[index])), { log: false });
    return;
  }
  // A resume at one of its condition evaluations (which failed) evaluates the wait again.
  state.resume.length = 0;
  // The wait a resumed run continues at is evaluated again but was logged when it first suspended.
  const again = state.waitResumed;
  state.waitResumed = false;
  await withCondition(
    state,
    step,
    async () => {
      state.waitDue = null;
      for (const variable of step.variables) state.vars.set(variable.name, variable.value);
      for (let index = 0; index < step.steps.length; index++) {
        if (halted(state)) return;
        const item = step.steps[index];
        if (item.kind !== 'branch') await at(state, index, () => runStep(state, item));
        else if (valueOf(state, item.condition) === true) {
          await at(state, index, async () => {
            await at(state, 'then', () => (item.then ? runSequence(state, item.then) : null));
            logBranch(state, item);
          });
          return;
        }
      }
      // A Timeout branch makes the run wake at its due time too (the earliest one); a write of a column the conditions read
      // still wakes it.
      const until = state.waitDue ?? null;
      state.suspended = {
        kind: until === null ? 'condition' : 'timeout',
        until,
        columns: step.columns ?? [],
        path: [...state.path],
      };
      state.host.trace(
        until === null
          ? 'Wait: no wait condition holds; the run waits for a change of the columns its conditions read.'
          : `Wait: no wait condition holds; the run waits until ${new Date(until).toISOString()} or a change of the columns its conditions read.`,
      );
    },
    { log: !again },
  );
}

// Postpone: a blocking one whose time has not come suspends the run until that time.
function runPostpone(state, step) {
  state.waitResumed = false;
  if (!step.block) return;
  const value = valueOf(state, step.until);
  const until = Date.parse(String(value ?? ''));
  if (!Number.isFinite(until)) fail('Postpone PostponeUntil is not a date and time.');
  if (until <= state.host.now()) return;
  state.suspended = { kind: 'timeout', until, columns: [], path: [...state.path] };
  state.host.trace(`Postpone: the run waits until ${new Date(until).toISOString()}.`);
}

// A step runs to completion or answers a promise of its completion (runStep awaits either).
/** @type {Map<string, (state: object, step: object) => void | Promise<void>>} */
const STEPS = new Map([
  ['sequence', runSequence],
  ['choice', runChoice],
  ['wait', runWait],
  ['postpone', runPostpone],
  ['branch', (state, step) => runBranch(state, step)],
  ['get', runGet],
  ['set', runSet],
  ['new', runAssign],
  ['id', runAssign],
  ['copy', runAssign],
  ['update', runWrite],
  ['create', runWrite],
  ['state', runState],
  [
    'expression',
    (state, step) => {
      const value = step.reference
        ? {
            id: step.reference.idVariable
              ? idOfValue(state.vars.get(step.reference.idVariable)) || null
              : step.reference.id,
            logical_name: step.reference.tables.find((table) => state.host.hasTable(table)) ?? step.reference.tables[0],
          }
        : step.literal;
      state.vars.set(step.result, clone(value));
    },
  ],
  [
    'add',
    // A text join of the operands; an empty operand adds nothing.
    (state, step) =>
      state.vars.set(
        step.result,
        step.sources.map((name) => (empty(state.vars.get(name)) ? '' : textOf(state.vars.get(name)))).join(''),
      ),
  ],
  ['now', (state, step) => state.vars.set(step.result, new Date(state.host.now()).toISOString())],
  // The designer's Timeout wait: an unset due time never comes; the condition holds once the clock reaches the due time,
  // which also becomes the time the waiting run is woken (the earliest due time of the wait's branches).
  ['orMax', (state, step) => empty(state.vars.get(step.variable)) && state.vars.set(step.variable, DATE_MAX_VALUE)],
  [
    'pastDue',
    (state, step) => {
      const due = Date.parse(String(state.vars.get(step.due) ?? ''));
      if (!Number.isFinite(due)) fail('The Timeout wait compares with a value that is not a date and time.');
      state.vars.set(step.result, state.host.now() >= due);
      if (due < Date.parse(DATE_MAX_VALUE)) state.waitDue = Math.min(state.waitDue ?? Infinity, due);
    },
  ],
  [
    'dateAdd',
    (state, step) => {
      const date = state.vars.get(step.date);
      const span = state.vars.get(step.span)?.timeSpan;
      if (!span) fail('A date Add has no time span.');
      state.vars.set(step.result, empty(date) ? null : shiftedDate(date, span));
    },
  ],
  [
    'first',
    (state, step) =>
      state.vars.set(
        step.result,
        clone(step.sources.map((name) => state.vars.get(name)).find((v) => !empty(v)) ?? null),
      ),
  ],
  [
    'condition',
    (state, step) =>
      state.vars.set(
        step.result,
        CONDITION_TESTS.get(step.operator)(
          valueOf(state, step.operand),
          step.parameters.map((operand) => valueOf(state, operand)),
        ),
      ),
  ],
  [
    'logical',
    (state, step) => {
      const left = valueOf(state, step.left) === true;
      const right = valueOf(state, step.right) === true;
      state.vars.set(step.result, step.operator === 'And' ? left && right : left || right);
    },
  ],
  ['convert', (state, step) => state.vars.set(step.result, convertValue(valueOf(state, step.value), step.type))],
  [
    'stop',
    (state, step) => {
      const reason = valueOf(state, step.reason);
      state.stop = { status: step.status, message: empty(reason) ? null : String(convertValue(reason, 'string')) };
      state.host.trace(`TerminateWorkflow: stopped ${step.status}.`);
    },
  ],
]);

// A date moved by an XrmTimeSpan: years and months by the calendar (the day clamped to the month's last day), then days,
// hours and minutes.
function shiftedDate(value, span) {
  const date = new Date(Date.parse(String(value)));
  if (!Number.isFinite(date.getTime())) fail('A date Add reads a value that is not a date and time.');
  const months = span.years * 12 + span.months;
  if (months) {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  return new Date(date.getTime() + ((span.days * 24 + span.hours) * 60 + span.minutes) * 60_000).toISOString();
}

// A text value of an Add operand: a lookup's name or id, a Boolean as True/False, else the value as text.
const textOf = (value) => {
  if (typeof value === 'object') return String(value.name ?? idOfValue(value));
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
};

const CONTAINERS = new Set(['choice', 'wait', 'branch']);

// A designer step that is not a condition or a branch (create, update, set state, stop, or a Sequence named for one) is
// logged when it completes; a step named inside it belongs to it. A failure marks it and the open conditions failed.
async function runStep(state, step) {
  const run = STEPS.get(step.kind);
  if (!step.step || CONTAINERS.has(step.kind) || state.action) return run(state, step);
  const entry = logEntry(step.step, null);
  state.action = entry;
  try {
    await run(state, step);
  } catch (error) {
    noteFailure(state, error, entry);
    throw error;
  } finally {
    state.action = null;
  }
  if (state.suspended) return;
  if (state.stop) entry.message = '';
  state.logs.push(entry);
}

/**
 * Runs a parsed program against its primary row. host: { primary: { logicalName, id, row }, idColumn(table), hasTable(table),
 * read(table, id) → row | null, create(table, data) → stored row, update(table, id, data) → stored row, trace(text),
 * now() → ms }. Answers { status: 'succeeded' | 'canceled', message } (canceled only from a Stop workflow step), or
 * { status: 'waiting', wait: { kind: 'condition' | 'timeout', until }, snapshot } when a wait or Postpone suspended it;
 * options.resume (that snapshot) continues the run there, with the primary row read again. A step that cannot be carried out
 * throws ClassicWorkflowError, and a host write's own error propagates unchanged.
 */
export async function runClassicWorkflow(program, host, { resume = null, suspendOnFailure = false } = {}) {
  const state = {
    host,
    vars: new Map(resume?.vars ?? (program.variables ?? []).map((variable) => [variable.name, variable.value])),
    input: new Map(),
    created: new Map(resume?.created ?? []),
    stop: null,
    suspended: null,
    failure: null,
    action: null,
    conditions: [],
    logs: [],
    path: [],
    resume: resume ? [...resume.path] : [],
    // A run resumed at a wait or Postpone evaluates it again without logging it again.
    waitResumed: resume ? resume.kind !== 'failure' : false,
  };
  const { logicalName, id, row } = host.primary;
  state.input.set('primaryEntity', entityOf(logicalName, id, row));
  const snapshot = (path, kind) => ({
    kind,
    path,
    vars: [...state.vars].map(clone),
    created: [...state.created].map(clone),
  });
  try {
    await runSequence(state, { variables: [], steps: program.steps });
  } catch (error) {
    // A background run that fails at a step waits there (the job Suspended / Waiting); its earlier writes stay.
    if (!suspendOnFailure) throw error;
    return { status: 'failed', error, logs: state.logs, snapshot: snapshot(state.failure?.path ?? [], 'failure') };
  }
  if (state.stop) return { ...state.stop, logs: state.logs };
  if (state.suspended) {
    const { kind, until, columns, path } = state.suspended;
    return { status: 'waiting', wait: { kind, until, columns }, logs: state.logs, snapshot: snapshot(path, kind) };
  }
  return { status: 'succeeded', message: null, logs: state.logs };
}
