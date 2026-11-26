import { cloneStateData } from './state-clone.mjs';
import { validateDerivedColumns } from './derived-columns.mjs';
import { relationshipsOf } from './dataverse-standard.mjs';
import { isElastic, samePartition } from './dataverse-elastic.mjs';
import { guidKey } from './dataverse-values.mjs';
import { countWork } from './work-counter.mjs';
import { untrackedMember } from './state-tracking.mjs';
import { decimalParts, decimalText, exactNumeric, isExactNumeric, roundNumeric, sumNumeric } from './exact-numeric.mjs';
// Rollup columns (SourceType 2) in the Dataverse API: the state and date columns are maintained, the value is recalculated on demand.
//
// A column is a rollup when its metadata says SourceType 2 (exported column facts sit under columnMetadata). Its FormulaDefinition
// is either designer-exported XAML for the simple child Count or an aggregate FetchXML model: one <entity> (the child table),
// one aggregate <attribute>, and a <filter> whose condition with value="{id}" names the child's parent lookup. Behaviour:
//   1. create: a new parent row is stamped <column>_state = 0 (NotCalculated) and <column>_date = null when the payload omits
//      them. An explicit write to <column> itself is refused with 400 (create, update and upsert).
//   2. child write (create, update, upsert, delete): every parent linked through a rollup column gets <column>_state = 0 (stale),
//      in the write's own transaction, so the mass recalculation picks it up. A reparent or delete marks the parent the row
//      pointed at before the write too. The flag is a journaled row mutation (store.mutateRow): the parent's versionnumber,
//      modifiedon and ETag stay, and no Update step, flow, audit or committed event runs for the parent.
//      The native platform keeps no per-row stale flag (its system job recalculates rollups incrementally); the _state = 0
//      marking only tells Mirage's own mass recalculation which rows to visit.
//   3. recalculate(api, table, id, column): the value is computed over the local child rows and stored with <column>_state = 1
//      (Calculated) and <column>_date = now. A trusted pack's rollups['<table>.<column>'](row, ctx) wins and supplies the value.
//      A definition outside the subset reports ROLLUP_UNSUPPORTED once per column and stores null with <column>_state = 2.
//
// Supported FormulaDefinition subset (element local names, case-insensitive, prefixes ignored):
//   <fetch aggregate="true"><entity name="child">
//     <attribute name="column" aggregate="count|sum|min|max|avg" alias="..."/>
//     <filter type="and">
//       <condition attribute="parentcolumn" operator="eq" value="{id}"/>
//       <condition attribute="statecode" operator="eq" value="0"/>   (optional)
//     </filter>
//   </entity></fetch>
// count counts the non-null values of the attribute; sum, min, max and avg read numbers and ignore nulls. A row without a
// statecode value counts as active. Anything else (link-entity, or-filters, other conditions, several attributes) is outside
// the subset.
// The designer's unfiltered, non-hierarchical one-to-many Count is parsed into the same model. Other XAML is unsupported.
// Aggregation follows SQL (SUM over no rows is 0, MIN, MAX and AVG over none are null, COUNT counts non-null values).
// State 2 (OverflowError) for a definition outside the subset is this module's choice: the nearest documented error state, as
// OtherError (3) describes an internal failure.
// Guesses: the refusal of a write to a rollup column reuses the calculated module's invalid-property shape (0x80048d19), and the
// 400 and 404 of recalculate reuse the CalculateRollupField handler's shapes.
// The rollup columns per table and the child -> parent sources are memoised per store.tablesRevision([]) (it changes on a
//   metadata commit, a promoted or non-incremental commit and a state replacement, not on an incremental row write) and on reset.
// Bare polymorphic target membership: a physical row insert or removal (store.beforeRowMembershipChange) first checks the
//   mappings-only set of polymorphic lookup targets (polymorphicTargets); a row of any other table resolves no column metadata.
//   Only a write to such a target reads the designer Count sources it competes for, built from the rollup columns of the
//   polymorphic target tables alone and memoised with the columns above. An elastic target is decided per child lookup
//   partition, a whole-table replacement of a target is found before commit (Raw target replacement below), and a lookup
//   that also targets a virtual table attributes no bare GUID. A rollup on or over a virtual or elastic table is refused.
// ponytail: aggregation runs over all child rows of the table (no index); fine for simulated data sets.
// ponytail: arithmetic uses JS doubles, so money results can differ in the last digits; route through exact-numeric.mjs when a
//   project needs exact decimals.
// Mass recalculation: when the runtime has a scheduler (api.scheduler), install schedules a recurring "Mass Calculate Rollup
//   Fields" task every MASS_INTERVAL_MS (the scheduler clamps long timers) that recalculates every stale (_state = 0) rollup
//   column of every row; describe(api) then reports MassRecalculation at behaviour, otherwise at contract.
//   The native job's cadence (hourly and incremental per column, configurable on the platform) is not modelled.
import { DataError } from './data-error.mjs';
import { parseSolutionXml } from './solution-xml.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';
import { onceReporter, packOverrides } from './dataverse-addon-common.mjs';
// runJob is imported when a job runs: a static import of dataverse-async.mjs would close an import cycle through
// dataverse-security.mjs and data.mjs (config-keys.mjs loads this module early).
const runJob = async (...args) => (await import('./dataverse-async.mjs')).runJob(...args);

const ROLLUP = 2;
const STATE = { notCalculated: 0, calculated: 1, overflowError: 2 };
const AGGREGATES = new Set(['count', 'sum', 'min', 'max', 'avg']);
const INVALID = '0x80040203';
const BEHAVIOUR_OPERATIONS = ['CreateState', 'StaleMark', 'Recalculate'];
const CONTRACT_OPERATIONS = ['MassRecalculation'];
const MASS_INTERVAL_MS = 3600 * 1000;
const MASS_JOB = 'Mass Calculate Rollup Fields';

const localName = (name) => String(name).split(':').pop().toLowerCase();
const elements = (node) => (node?.children ?? []).filter((item) => !item.name.startsWith('#'));
const attr = (node, name) =>
  Object.entries(node.attrs ?? {}).find(([key]) => localName(key) === name.toLowerCase())?.[1];
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value);
const bare = (value) =>
  String(refId(value) ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const sameId = (a, b) => bare(a) !== '' && bare(a) === bare(b);
const enumValue = (value) => (value !== null && typeof value === 'object' ? value.Value : value);
const facts = (definition) => ({ ...definition, ...definition?.columnMetadata });
const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';
const hasKey = (data, name) => Object.keys(data).some((key) => key.toLowerCase() === name);

class Unsupported extends Error {}
const unsupported = (message) => {
  throw new Unsupported(message);
};

const invalid = (message) => new DataError(message, 400, 'InvalidRequest', { innerCode: INVALID });
const notFound = (logical, id) =>
  new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id, innerCode: '0x80040217' });

/**
 * The definition check a rollup column create makes: a designer Aggregate whose ExpressionOperator is not one of Count,
 * Sum, Average, Minimum or Maximum (hosted runs refuse Min and Max) answers 400 0x80060417 "FormulaDefinition is not
 * valid Xaml". Any other definition is stored as received; one outside the supported subset reads state 2 when calculated.
 */
export function assertRollupDefinition(text) {
  if (typeof text !== 'string' || !/<Activity[\s>]/.test(text)) return;
  let root;
  try {
    root = parseSolutionXml(text);
  } catch {
    return;
  }
  const operators = [];
  const visit = (node, aggregate) => {
    const inside = aggregate || (localName(node.name) === 'sequence' && attr(node, 'DisplayName') === 'Aggregate');
    if (inside && localName(node.name) === 'inargument' && attr(node, 'Key') === 'ExpressionOperator')
      operators.push(node.text.trim());
    for (const child of elements(node)) visit(child, inside);
  };
  visit(root, false);
  if (operators.some((operator) => !Object.hasOwn(DESIGNER_AGGREGATES, operator)))
    throw new DataError('FormulaDefinition is not valid Xaml', 400, 'InvalidFormulaDefinition', {
      innerCode: '0x80060417',
    });
}

// ---- Parser: FormulaDefinition text -> rule

// Reads the parts of the rule in order: child and link first, so a rule outside the aggregate subset still names its 1:N source.
function readFetch(root, rule) {
  validateFetchRoot(root);
  const { filters, attributes, filter } = fetchComponents(root, rule);
  const idCondition = elements(filter).find(
    (item) =>
      localName(item.name) === 'condition' &&
      String(attr(item, 'value') ?? '')
        .trim()
        .toLowerCase() === '{id}',
  );
  rule.link =
    String(attr(idCondition ?? {}, 'attribute') ?? '')
      .trim()
      .toLowerCase() || null;
  if (!rule.link) unsupported('The filter needs a condition with value {id} naming the parent column.');
  validateFetchFilter(filters, filter, idCondition, rule);
  readAggregateRule(rule, attributes);
}

function validateFetchRoot(root) {
  if (localName(root.name) !== 'fetch') unsupported('The FormulaDefinition is not a <fetch> query.');
  if (String(attr(root, 'aggregate') ?? '').toLowerCase() !== 'true')
    unsupported('The <fetch> is not an aggregate query (aggregate="true").');
}

function fetchComponents(root, rule) {
  const entities = elements(root);
  if (entities.length !== 1 || localName(entities[0].name) !== 'entity')
    unsupported('The <fetch> must hold exactly one <entity>.');
  const entity = entities[0];
  rule.child =
    String(attr(entity, 'name') ?? '')
      .trim()
      .toLowerCase() || null;
  if (!rule.child) unsupported('The <entity> names no table.');
  const parts = elements(entity);
  const filters = parts.filter((item) => localName(item.name) === 'filter');
  const attributes = parts.filter((item) => localName(item.name) === 'attribute');
  if (filters.length + attributes.length !== parts.length)
    unsupported('The <entity> holds an element outside the subset (link-entity, order, ...).');
  const [filter] = filters;
  if (!filter) unsupported('The query has no <filter> with an {id} condition.');
  return { filters, attributes, filter };
}

function validateFetchFilter(filters, filter, idCondition, rule) {
  if (filters.length > 1) unsupported('The query has more than one <filter>.');
  if (String(attr(filter, 'type') ?? 'and').toLowerCase() !== 'and') unsupported('Only an and-filter is supported.');
  const conditions = elements(filter);
  if (conditions.some((item) => localName(item.name) !== 'condition')) unsupported('A nested filter is not supported.');
  if (String(attr(idCondition, 'operator') ?? '').toLowerCase() !== 'eq')
    unsupported('The {id} condition must use operator eq.');
  rule.active = false;
  for (const condition of conditions) checkRollupCondition(rule, condition, idCondition);
}

function checkRollupCondition(rule, condition, idCondition) {
  if (condition === idCondition) return;
  const field = String(attr(condition, 'attribute') ?? '')
    .trim()
    .toLowerCase();
  const operator = String(attr(condition, 'operator') ?? '').toLowerCase();
  if (
    field === 'statecode' &&
    operator === 'eq' &&
    String(attr(condition, 'value') ?? '').trim() === '0' &&
    !rule.active
  )
    rule.active = true;
  else unsupported(`The condition on '${field}' is outside the subset.`);
}

function readAggregateRule(rule, attributes) {
  if (attributes.length !== 1) unsupported('The aggregate names exactly one <attribute>.');
  const aggregate = String(attr(attributes[0], 'aggregate') ?? '').toLowerCase();
  if (!AGGREGATES.has(aggregate)) unsupported(`Aggregate '${aggregate || 'none'}' is not supported.`);
  rule.aggregate = aggregate;
  rule.attribute = String(attr(attributes[0], 'name') ?? '')
    .trim()
    .toLowerCase();
  if (!rule.attribute) unsupported('The aggregate attribute has no name.');
}

function designerSteps(node, names) {
  const nodes = elements(node);
  if (nodes.length !== names.length || nodes.some((item, index) => localName(item.name) !== names[index]))
    unsupported('The designer rollup has activities outside the supported layout.');
  return nodes;
}

// Source: HierarchicalRelationshipName is [Nothing] for a direct rollup, else the self-referencing relationship whose
// descendants also contribute (the parent row and every row below it).
function checkDesignerSource(source, rule) {
  const [variables] = designerSteps(source, ['sequence.variables']);
  const [hierarchy] = designerSteps(variables, ['variable']);
  const name = attr(hierarchy, 'Default');
  if (attr(hierarchy, 'Name') !== 'HierarchicalRelationshipName' || !name)
    unsupported('The designer rollup source declares no HierarchicalRelationshipName.');
  if (name === '[Nothing]') return;
  if (!/^[a-z][\da-z_]*$/i.test(name))
    unsupported('The designer rollup names an unreadable hierarchical relationship.');
  rule.hierarchy = name.toLowerCase();
}

function readDesignerLink(link, rule) {
  const relation =
    /^\[CreatedEntities\("relatedlinked_([a-z][\da-z_]*)#([a-z][\da-z_]*)#([a-z][\da-z_]*)#Temp"\)\]$/i.exec(
      attr(link, 'Entity') ?? '',
    );
  if (
    localName(link?.name ?? '') !== 'setattributevalue' ||
    !relation ||
    attr(link, 'EntityName')?.toLowerCase() !== relation[3].toLowerCase()
  )
    unsupported('The designer rollup does not declare a direct child relationship.');
  rule.child = relation[3].toLowerCase();
  rule.link = relation[2].toLowerCase();
  const relationship = relation[1].toLowerCase();
  const relationshipLabel = [rule.child, rule.link, relationship].join('.');
  if (attr(link, 'DisplayName')?.toLowerCase() !== relationshipLabel)
    unsupported('The designer rollup child relationship declarations do not match.');
  rule.relationship = relationship;
}

const ACTIVITY = 'Microsoft.Crm.Workflow.Activities.';
const variableOf = (text) => /^\[([a-z][\da-z_]*)\]$/i.exec(String(text ?? '').trim())?.[1] ?? null;
// The arguments of an ActivityReference by x:Key; an x:Null argument reads as null.
function activityArguments(reference) {
  const [args] = designerSteps(reference, ['activityreference.arguments']);
  const values = new Map();
  for (const item of elements(args)) values.set(attr(item, 'Key'), localName(item.name) === 'null' ? null : item);
  return values;
}
const argumentText = (args, key) => (args.get(key) ? args.get(key).text.trim() : null);

// A literal of the filter (EvaluateExpression CreateCrmType): the option set, Boolean and decimal forms the designer writes.
const LITERAL =
  /^\[New Object\(\) \{ Microsoft\.Xrm\.Sdk\.Workflow\.WorkflowPropertyType\.(\w+), "([^"]*)"(?:, "[^"]*")? \}\]$/;
function filterLiteral(args) {
  if (argumentText(args, 'ExpressionOperator') !== 'CreateCrmType')
    unsupported('The designer filter computes an expression other than a literal.');
  const literal = LITERAL.exec(argumentText(args, 'Parameters') ?? '');
  if (!literal) unsupported('The designer filter literal is not readable.');
  const [, type, text] = literal;
  if (type === 'Boolean' && (text === 'True' || text === 'False')) return text === 'True';
  if (['OptionSetValue', 'Decimal', 'Integer', 'Double', 'Money'].includes(type) && Number.isFinite(Number(text)))
    return Number(text);
  return unsupported(`The designer filter literal type ${type} is not supported.`);
}

// The observed filter conditions; another operator leaves the rule unsupported.
const CONDITIONS = new Set(['Equal', 'GreaterThan', 'NotNull']);

function filterCondition(args, values) {
  const operator = argumentText(args, 'ConditionOperator');
  if (!CONDITIONS.has(operator)) unsupported(`The designer filter operator ${operator} is not supported.`);
  const operand = values.get(variableOf(argumentText(args, 'Operand')));
  if (operand?.kind !== 'column') unsupported('The designer filter condition does not read a child column.');
  const parameters = argumentText(args, 'Parameters');
  if (operator === 'NotNull') {
    if (parameters !== null) unsupported('The NotNull filter condition takes no parameter.');
    return { kind: 'condition', operator, column: operand.column };
  }
  const parameter = values.get(/^\[New Object\(\) \{ ([a-z][\da-z_]*) \}\]$/i.exec(parameters ?? '')?.[1]);
  if (parameter?.kind !== 'literal') unsupported('The designer filter condition compares with no literal.');
  return { kind: 'condition', operator, column: operand.column, value: parameter.value };
}

function filterStep(step, rule, values) {
  if (localName(step.name) === 'getentityproperty') {
    const column = attr(step, 'Attribute');
    if (
      !/^[a-z][\da-z_]*$/i.test(column ?? '') ||
      attr(step, 'Entity') !== '[InputEntities("primaryEntity")]' ||
      attr(step, 'EntityName')?.toLowerCase() !== rule.child
    )
      unsupported('The designer filter does not read a child column.');
    return [variableOf(attr(step, 'Value')), { kind: 'column', column: column.toLowerCase() }];
  }
  if (localName(step.name) !== 'activityreference') unsupported('The designer filter has an unknown activity.');
  const kind = attr(step, 'AssemblyQualifiedName')?.split(',')[0];
  const args = activityArguments(step);
  const result = variableOf(argumentText(args, 'Result'));
  if (kind === `${ACTIVITY}EvaluateExpression`) return [result, { kind: 'literal', value: filterLiteral(args) }];
  if (kind === `${ACTIVITY}EvaluateCondition`) return [result, filterCondition(args, values)];
  if (kind === `${ACTIVITY}EvaluateLogicalCondition`) {
    if (argumentText(args, 'LogicalOperator') !== 'And')
      unsupported('The designer filter combines conditions with Or.');
    const [left, right] = ['LeftOperand', 'RightOperand'].map((key) => values.get(variableOf(argumentText(args, key))));
    if (!['condition', 'and'].includes(left?.kind) || !['condition', 'and'].includes(right?.kind))
      unsupported('The designer filter combines values that are not conditions.');
    return [result, { kind: 'and', left, right }];
  }
  return unsupported('The designer filter has an unknown activity.');
}

// Target: the child relationship, then an optional filter program whose result is the first Boolean variable.
function readDesignerTarget(target, rule) {
  const nodes = elements(target);
  const declared = localName(nodes[0]?.name ?? '') === 'sequence.variables' ? nodes.shift() : null;
  readDesignerLink(nodes.shift(), rule);
  if (!nodes.length) return;
  const values = new Map();
  for (const step of nodes) {
    const [name, value] = filterStep(step, rule, values);
    if (!name) unsupported('The designer filter step stores no result.');
    values.set(name, value);
  }
  const result = elements(declared).find((item) => attr(item, 'TypeArguments') === 'x:Boolean');
  const filter = values.get(attr(result ?? {}, 'Name'));
  if (!['condition', 'and'].includes(filter?.kind)) unsupported('The designer filter has no condition result.');
  rule.filter = filter;
}

// The designer aggregate operators; Min and Max are refused at definition (0x80060417, assertRollupDefinition).
const DESIGNER_AGGREGATES = { Count: 'count', Sum: 'sum', Average: 'avg', Minimum: 'min', Maximum: 'max' };

function readDesignerAggregate(aggregate, rule) {
  const [, property, expression] = designerSteps(aggregate, [
    'sequence.variables',
    'getentityproperty',
    'activityreference',
  ]);
  const column = attr(property, 'Attribute');
  const variable = variableOf(attr(property, 'Value'));
  if (
    !/^[a-z][\da-z_]*$/i.test(column ?? '') ||
    !variable ||
    attr(property, 'Entity') !== '[InputEntities("primaryEntity")]' ||
    attr(property, 'EntityName')?.toLowerCase() !== rule.child ||
    attr(expression, 'AssemblyQualifiedName')?.split(',')[0] !== `${ACTIVITY}EvaluateExpression`
  )
    unsupported('The designer aggregate does not read a child column.');
  const [args] = designerSteps(expression, ['activityreference.arguments']);
  const [operator, parameters, type, result] = designerSteps(args, [
    'inargument',
    'inargument',
    'inargument',
    'outargument',
  ]);
  const aggregateName = operator.text.trim();
  if (
    attr(operator, 'Key') !== 'ExpressionOperator' ||
    !Object.hasOwn(DESIGNER_AGGREGATES, aggregateName) ||
    attr(parameters, 'Key') !== 'Parameters' ||
    parameters.text.trim() !== `[New Object() { ${variable} }]` ||
    attr(type, 'Key') !== 'TargetType' ||
    attr(result, 'Key') !== 'Result'
  )
    unsupported('The designer aggregate does not match an exported Count, Sum, Average, Minimum or Maximum.');
  rule.aggregate = DESIGNER_AGGREGATES[aggregateName];
  rule.attribute = column.toLowerCase();
  rule.active = false;
}

function readDesignerRollup(root, rule) {
  const activity = attr(root, 'Class')?.toLowerCase();
  if (!/^xrmworkflow[\da-f]{32}$/.test(activity ?? ''))
    unsupported('The designer rollup requires a generated Workflow class.');
  const [, , , , workflow] = designerSteps(root, [
    'members',
    `${activity}.inputentities`,
    `${activity}.createdentities`,
    'visualbasic.settings',
    'workflow',
  ]);
  const [sequence] = designerSteps(workflow, ['sequence']);
  const [source, target, aggregate] = designerSteps(sequence, ['sequence', 'sequence', 'sequence']);
  if (
    !/^RollupRuleStep\d+$/.test(attr(sequence, 'DisplayName') ?? '') ||
    attr(source, 'DisplayName') !== 'Source' ||
    attr(target, 'DisplayName') !== 'Target' ||
    attr(aggregate, 'DisplayName') !== 'Aggregate'
  )
    unsupported('The designer rollup is outside the Source, Target and Aggregate layout.');
  rule.form = 'designer';
  checkDesignerSource(source, rule);
  readDesignerTarget(target, rule);
  readDesignerAggregate(aggregate, rule);
}

/**
 * Parses a rollup FormulaDefinition into { child, link, relationship?, active, aggregate, attribute, unsupported }. child and link (the 1:N
 * source) are kept even when the rest is outside the subset: unsupported is then the reason, null when the rule is supported.
 */
export function parseRollupFormula(text) {
  const rule = { child: null, link: null, unsupported: null };
  if (!text || !String(text).trim()) return { ...rule, unsupported: 'The column has no FormulaDefinition.' };
  try {
    const root = parseSolutionXml(text);
    if (localName(root.name) === 'activity') readDesignerRollup(root, rule);
    else readFetch(root, rule);
  } catch (error) {
    rule.unsupported =
      error instanceof Unsupported ? error.message : `The FormulaDefinition is not readable XML: ${error.message}`;
  }
  return rule;
}

// ---- Companion columns

const INTEGER_RANGE = { minValue: -2147483648, maxValue: 2147483647 };
const relabel = (labels, text) =>
  Object.fromEntries(Object.entries(labels ?? {}).map(([lcid, label]) => [lcid, text(label)]));
// One companion as the platform creates it: labels and descriptions derive from the rollup column's display name.
function companion(column, { suffix, label, description, dataverseType, facts: extra, field }) {
  const schemaName = `${column.schemaName ?? column.name}_${suffix}`;
  return {
    dataverseType,
    validForCreate: false,
    validForUpdate: false,
    validForRead: true,
    schemaName,
    ...field,
    columnMetadata: {
      type: dataverseType,
      schemaName,
      labels: relabel(column.labels, (text) => `${text} (${label})`),
      descriptionLabels: relabel(column.labels, description),
      validForCreate: false,
      validForUpdate: false,
      validForRead: true,
      sourceType: 0,
      ...(column.isCustomField === undefined ? {} : { isCustomField: column.isCustomField }),
      ...(column.customTable === undefined ? {} : { customTable: column.customTable }),
      ...extra,
    },
    dataverseMetadata: {
      FormulaDefinition: null,
      CanBeSecuredForRead: false,
      CanBeSecuredForCreate: false,
      CanBeSecuredForUpdate: false,
    },
  };
}

/**
 * The field definitions with the platform companions of every rollup column (SourceType 2): <column>_date (DateTime,
 * UserLocal) and <column>_state (Integer), read-only simple columns. Solution exports do not list them; a declared
 * companion keeps its own facts over these. A row that holds no companion value (it predates the column or comes from a
 * data pack) reads null, as a never-calculated row does natively; only a row created through Mirage is stamped state 0.
 */
export function withRollupCompanions(fields) {
  let result = fields;
  for (const [name, definition] of Object.entries(fields ?? {})) {
    const column = { name, ...facts(definition) };
    if (Number(enumValue(column.sourceType ?? column.SourceType)) !== ROLLUP) continue;
    if (result === fields) result = { ...fields };
    const generated = {
      [`${name}_date`]: companion(column, {
        suffix: 'Date',
        label: 'Last Updated On',
        description: (text) => `Last Updated time of rollup field ${text}.`,
        dataverseType: 'datetime',
        facts: { format: 'datetime', imeMode: 'inactive' },
        field: { dateTimeBehavior: 'UserLocal' },
      }),
      [`${name}_state`]: companion(column, {
        suffix: 'State',
        label: 'State',
        description: (text) => `State of rollup field ${text}.`,
        dataverseType: 'int',
        facts: { format: 'none', ...INTEGER_RANGE },
      }),
    };
    for (const [key, value] of Object.entries(generated)) {
      const declared = fields[key];
      result[key] = declared
        ? { ...value, ...declared, columnMetadata: { ...value.columnMetadata, ...declared.columnMetadata } }
        : value;
    }
  }
  return result;
}

// ---- Aggregation

const asNumber = (value) => {
  let number;
  if (typeof value === 'number') number = value;
  else if (isExactNumeric(value)) number = Number(value.value);
  else if (typeof value === 'string' && value.trim() !== '') number = Number(value);
  else number = Number.NaN;
  if (!Number.isFinite(number)) unsupported(`'${value}' is not a number.`);
  return number;
};
// A child value as an exact decimal operand (a number, a numeric string or an exact decimal).
const asDecimal = (value) => {
  asNumber(value);
  return isExactNumeric(value) ? value : String(value);
};

// The places a rollup column stores, as the calculated path rounds (dataverse-calculated.mjs typedValue): whole numbers 0,
// decimal and money their Precision (at most 10 and 4), else none.
function rollupPlaces(api, logical, column) {
  const definition = api.store.fieldDefinitions(logical, api.metadataFields)?.[column] ?? {};
  const facts = { ...definition, ...definition.columnMetadata };
  const type = String(facts.dataverseType ?? facts.type ?? '').toLowerCase();
  if (['int', 'integer', 'bigint', 'whole'].includes(type)) return { places: 0, numericType: 'Decimal' };
  if (type !== 'decimal' && type !== 'money') return null;
  const precision = Number(facts.precision ?? facts.Precision ?? 2);
  const most = type === 'money' ? 4 : 10;
  return {
    places: Number.isInteger(precision) ? Math.min(most, Math.max(0, precision)) : 2,
    numericType: type === 'money' ? 'Money' : 'Decimal',
  };
}

// The quotient sum / count rounded half away from zero to `places` (28 when the column names none).
function dividedNumeric(sum, count, places = 28) {
  const parts = decimalParts(sum);
  const numerator = parts.coefficient * 10n ** BigInt(places);
  const divisor = BigInt(count) * 10n ** BigInt(parts.scale);
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / divisor + ((absolute % divisor) * 2n >= divisor ? 1n : 0n);
  return exactNumeric(decimalText({ coefficient: negative ? -quotient : quotient, scale: places }), 'Decimal');
}

// A numeric rollup value in the column's type: rounded to its places; a plain number stays plain when it holds the digits.
function storedNumber(value, typed) {
  if (!typed || (typeof value !== 'number' && !isExactNumeric(value))) return value;
  const rounded = roundNumeric(value, typed.places, typed.numericType);
  return isExactNumeric(rounded) && typed.places === 0 ? Number(rounded.value) : rounded;
}

// The named relationship disambiguates the same lookup column on a polymorphic child.
function rollupSource(store, table, rule, allowUnresolved = false) {
  const source = { table, link: rule.link };
  if (!rule.relationship) return source;
  const parentId = bare(store.state.mappings?.[table]?.idColumn);
  if (!parentId) return allowUnresolved ? source : null;
  const links = Object.values(relationshipsOf(store, rule.child)).filter(
    (link) => !link.many && bare(link.from) === rule.link,
  );
  const toParent = links.filter((link) => bare(link.entity) === table && bare(link.to ?? parentId) === parentId);
  const named = toParent.some((link) => bare(link.schemaName) === rule.relationship);
  // Older explicit mappings can describe a unique direct link without a schema name.
  const unnamed = links.length === 1 && toParent.length === 1 && !toParent[0].schemaName;
  if (!named && !unnamed) return allowUnresolved ? source : null;
  const targets = new Map(links.map((link) => [bare(link.entity), link]));
  return { ...source, relationship: rule.relationship, targets: targets.size > 1 ? [...targets.values()] : null };
}

function bareRollupTarget(store, targets, row) {
  try {
    return bare(store.bareLookupHolder(targets, row)?.entity);
  } catch (error) {
    // An ambiguous or unavailable target cannot be counted for any parent.
    if (error instanceof DataError && ['InvalidLookup', 'UnknownEntity'].includes(error.code)) return '';
    throw error;
  }
}

function rollupParentId(store, source, row) {
  const lookup = row?.[source.link];
  const id = bare(lookup);
  if (!id || !source.relationship) return id;
  const target = bare(lookup?.logical_name ?? lookup?.logicalName);
  if (target) return target === source.table ? id : '';
  if (!source.targets) return id;
  // A bare GUID names no table: with a candidate target whose rows live outside the store, no holder can be established.
  if (hasVirtualTarget(store, source)) return '';
  return bareRollupTarget(store, source.targets, row) === source.table ? id : '';
}

// ---- Table kinds outside regular local storage
//
// Learn: virtual table columns can't be used in rollups, and rollups can't be calculated for virtual tables (they are a
// server-side calculation over locally stored data); elastic tables support no calculated or rollup columns, and Mirage
// refuses a lookup on an elastic table (dataverse-elastic.mjs assertElasticOneToMany). An elastic table can still be a
// lookup target: its rows are addressed by primary key and partition.

function isVirtualTable(store, table) {
  const mapping = store.state.mappings?.[table];
  return Boolean(
    mapping?.isVirtual ||
    mapping?.tableType === 'Virtual' ||
    mapping?.dataSourceId ||
    mapping?.dataverseMetadata?.DataSourceId ||
    store.virtualTable(table) ||
    store.recordPipeline?.virtualProviders?.status(table)?.virtual,
  );
}

function tableKind(store, table) {
  if (isElastic(store.state.mappings?.[table])) return 'elastic';
  return isVirtualTable(store, table) ? 'virtual' : null;
}

const hasVirtualTarget = (store, source) =>
  Boolean(source.targets?.some(({ entity }) => isVirtualTable(store, bare(entity))));

// The reason a rollup of `table` over `child` cannot be calculated, or null.
function refusedTableReason(store, table, child) {
  for (const name of [table, child]) {
    const kind = tableKind(store, name);
    if (kind === 'virtual')
      return `${name} is a virtual table, and Dataverse calculates no rollup on or over a virtual table.`;
    if (kind === 'elastic')
      return `${name} is an elastic table, and elastic tables hold no rollup columns or lookups of their own.`;
  }
  return null;
}

// The lookup column of the self-referencing relationship a hierarchical rollup follows, or null when the table has none.
function hierarchyLinkOf(store, table, hierarchy) {
  const link = Object.values(relationshipsOf(store, table)).find(
    (relationship) =>
      !relationship.many && bare(relationship.schemaName) === hierarchy && bare(relationship.entity) === table,
  );
  return link ? bare(link.from) : null;
}

// The parent and, for a hierarchical rollup, every row below it through the self-referencing relationship.
function rollupParents(store, rule, source, parentId) {
  if (!rule.hierarchy) return new Set([bare(parentId)]);
  const link = hierarchyLinkOf(store, source.table, rule.hierarchy);
  if (!link)
    unsupported(`The hierarchical relationship ${rule.hierarchy} is not a self-referencing lookup of ${source.table}.`);
  const mapping = store.resolveMapping(source.table);
  const parents = store.tableRows(mapping.logicalName);
  const ids = new Set([bare(parentId)]);
  let frontier = [...ids];
  while (frontier.length) {
    const reached = new Set(frontier);
    frontier = [];
    for (const row of parents) {
      const id = bare(row[mapping.idColumn]);
      if (!ids.has(id) && reached.has(bare(row[link]))) {
        ids.add(id);
        frontier.push(id);
      }
    }
  }
  return ids;
}

const scalarOf = (value) =>
  value !== null && typeof value === 'object' ? (value.Value ?? value.value ?? value) : value;
const isBlank = (value) => value === null || value === undefined || value === '';

// The designer filter on one child row: Equal (option set, Boolean, number), GreaterThan (number) and NotNull, joined by And.
function filterMatches(filter, row) {
  if (filter.kind === 'and') return filterMatches(filter.left, row) && filterMatches(filter.right, row);
  const value = scalarOf(row[filter.column]);
  if (filter.operator === 'NotNull') return !isBlank(value);
  if (isBlank(value)) return false;
  if (filter.operator === 'Equal')
    return typeof filter.value === 'boolean' ? value === filter.value : Number(value) === filter.value;
  return Number(value) > filter.value;
}

// A date or date and time value as the Web API writes it; Date.parse then reads it.
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:T|$)/;

// Minimum or Maximum over numbers, or over date and time values (the original value is kept).
function extremeOf(values, aggregate) {
  if (!values.length) return null;
  const dates = values.every((value) => typeof value === 'string' && DATE_TEXT.test(value));
  const keyed = values.map((value) => ({ value, key: dates ? Date.parse(value) : asNumber(value) }));
  if (keyed.some(({ key }) => !Number.isFinite(key)))
    unsupported('A value under the aggregate is not a number or date.');
  const better = aggregate === 'min' ? (item, best) => item.key < best.key : (item, best) => item.key > best.key;
  return keyed.reduce((best, item) => (better(item, best) ? item : best)).value;
}

/**
 * Aggregates the child rows linked to the parent (and its descendants for a hierarchical rollup), active rows only when the
 * FetchXML rule says so, filtered by a designer filter. COUNT counts non-null values; SUM skips nulls (0 over none);
 * MIN and MAX ignore nulls (null over none). AVG follows the form: a designer Average divides the sum by every linked row
 * (a null counts as 0, and over none it is 0, as hosted runs show), a FetchXML avg follows SQL (nulls ignored, null over none).
 */
function aggregateOf(store, rule, source, rows, parentId, typed = null) {
  const parents = rollupParents(store, rule, source, parentId);
  const linked = rows.filter((row) => {
    const parent = bare(row[source.link]);
    return (
      parents.has(parent) &&
      (!rule.active || Number(row.statecode ?? 0) === 0) &&
      rollupParentId(store, source, row) === parent &&
      (!rule.filter || filterMatches(rule.filter, row))
    );
  });
  const values = linked.map((row) => scalarOf(row[rule.attribute])).filter((value) => !isBlank(value));
  if (rule.aggregate === 'count') return values.length;
  if (rule.aggregate === 'min' || rule.aggregate === 'max')
    return storedNumber(extremeOf(values, rule.aggregate), typed);
  // Exact decimal arithmetic: 0.1 + 0.2 is 0.3, as the platform's decimal columns add.
  const sum = sumNumeric(values.map(asDecimal));
  if (rule.aggregate === 'sum') return storedNumber(sum, typed);
  const count = rule.form === 'designer' ? linked.length : values.length;
  if (!count) return rule.form === 'designer' ? 0 : null;
  return storedNumber(dividedNumeric(sum, count, typed?.places), typed);
}

// The value a parent holds before any child counts: COUNT, SUM and a designer Average are 0, MIN, MAX and a FetchXML avg null.
function emptyValue(rule) {
  if (rule.unsupported) return null;
  if (rule.aggregate === 'count' || rule.aggregate === 'sum') return 0;
  if (rule.aggregate === 'avg' && rule.form === 'designer') return 0;
  return null;
}

// ---- Rules of a table

const states = new WeakMap();
// The _date companions a create stamped, per request context, until afterWrite gives them the created row's createdon.
const createdStamps = new WeakMap();

function stampCreatedOn(api, c, mapping, id) {
  const list = createdStamps.get(c);
  const index = list?.findLastIndex((entry) => entry.table === mapping.logicalName) ?? -1;
  if (index < 0) return;
  const [{ stamped }] = list.splice(index, 1);
  const rows = api.store.state.tables[mapping.logicalName] ?? [];
  const at = api.store.rowIndex(mapping, rows, id);
  if (at < 0 || !rows[at].createdon) return;
  api.store.mutateRow(
    mapping.logicalName,
    rows,
    at,
    Object.fromEntries(stamped.map((column) => [column, rows[at].createdon])),
  );
}

// Pre-images of writes in flight, per request context: the parents the row pointed at before the write (for reparent and delete).
const pending = new WeakMap();

function stateOf(api) {
  if (!states.has(api))
    states.set(api, {
      overrides: {},
      reporter: onceReporter(),
      parsed: new Map(),
      memo: null,
      stale: new Set(),
      pendingMarks: new WeakMap(),
    });
  return states.get(api);
}

const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.table}\u0000${entry.column}`);

// The memo of rollup columns and sources, dropped when the store's table revision moves (see the header).
function memoOf(api, metadata) {
  const state = stateOf(api);
  const key = api.store.tablesRevision([]);
  if (state.memo?.key !== key || state.memo?.metadata !== metadata)
    state.memo = { key, metadata, columns: new Map(), sources: null, competingTargets: null };
  return state.memo;
}

// The rollup columns of a table as { name: formulaDefinition }.
function rollupColumnsOf(api, logical, metadata = api.metadataSnapshot?.()) {
  const memo = memoOf(api, metadata);
  if (memo.columns.has(logical)) return memo.columns.get(logical);
  const definitions =
    api.store.fieldDefinitions(logical, metadata ? (name) => metadata[name]?.fields : api.metadataFields) ?? {};
  const result = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const column = facts(definition);
    if (Number(enumValue(column.sourceType ?? column.SourceType)) === ROLLUP)
      result[name.toLowerCase()] = column.formulaDefinition ?? column.FormulaDefinition ?? '';
  }
  memo.columns.set(logical, result);
  return result;
}

function parsedOf(state, formula) {
  if (!state.parsed.has(formula)) state.parsed.set(formula, parseRollupFormula(formula));
  return state.parsed.get(formula);
}

function addRollupSource(index, name, source) {
  if (!index.has(name)) index.set(name, []);
  index.get(name).push(source);
}

function rollupDetail(store, state, table, column, formula) {
  const rule = parsedOf(state, formula);
  if (!rule.child || !rule.link) return null;
  const overridden = Object.hasOwn(state.overrides, `${table}.${column}`);
  const source = rollupSource(store, table, rule, overridden);
  if (!source) return null;
  const detail = {
    ...source,
    child: rule.child,
    attribute: rule.attribute,
    column,
    aggregate: rule.aggregate,
    filter: rule.filter ?? null,
    hierarchyLink: rule.hierarchy ? hierarchyLinkOf(store, table, rule.hierarchy) : null,
  };
  // A designer rollup tracks bare membership for every aggregate; a FetchXML rule only for the unfiltered count.
  const counted =
    !overridden &&
    !rule.unsupported &&
    !rule.active &&
    (rule.form === 'designer' ? !rule.hierarchy || detail.hierarchyLink : rule.aggregate === 'count');
  return { detail, counted: Boolean(counted) };
}

function indexRollupSource(store, state, memo, table, column, formula) {
  const entry = rollupDetail(store, state, table, column, formula);
  if (!entry) return;
  addRollupSource(memo.sources, entry.detail.child, entry.detail);
  // A write that moves a row of a hierarchical parent table changes the rollups of its old and new ancestors.
  if (entry.detail.hierarchyLink) addRollupSource(memo.sources, table, { ...entry.detail, hierarchyOnly: true });
}

// The tables that are one of several targets of a child's many-to-one lookup column, read from the mappings alone
// (no column metadata). Only such a table can be a competing target of a designer Count, so a row write to any other
// table skips the membership check without resolving metadata. Memoised per store.tablesRevision([]): mappings change
// only on a metadata, non-incremental or replacing commit, never on an incremental row write.
function polymorphicTargets(api, state) {
  const store = api.store;
  const key = store.tablesRevision([]);
  if (state.polymorphic?.key === key) return state.polymorphic.tables;
  const tables = new Set();
  // The other targets of each lookup a table is a target of: a parent of a competing source is one of them.
  const partners = new Map();
  for (const child of Object.keys(store.state.mappings ?? {}))
    for (const entities of lookupTargets(store, child).values())
      if (entities.size > 1) addLookupPartners(tables, partners, entities);
  state.polymorphic = { key, tables, partners };
  return tables;
}

function addLookupPartners(tables, partners, entities) {
  for (const entity of entities) {
    tables.add(entity);
    if (!partners.has(entity)) partners.set(entity, new Set());
    for (const other of entities) if (other !== entity) partners.get(entity).add(other);
  }
}

// Each many-to-one lookup column of a child, with the tables it targets.
function lookupTargets(store, child) {
  const groups = new Map();
  for (const link of Object.values(relationshipsOf(store, child))) {
    if (link.many) continue;
    const from = bare(link.from);
    if (!groups.has(from)) groups.set(from, new Set());
    groups.get(from).add(bare(link.entity));
  }
  return groups;
}

// The designer Count sources for which a table is a competing (non-own) polymorphic target. Only the rollup columns
// of the polymorphic target tables are read: a parent outside them has no competing target.
function competingSourcesOf(api, state, table) {
  const metadata = api.metadataSnapshot?.();
  const memo = memoOf(api, metadata);
  if (!memo.competingTargets) {
    memo.competingTargets = new Map();
    for (const parent of polymorphicTargets(api, state)) {
      if (!api.store.state.mappings?.[parent]) continue;
      for (const [column, formula] of Object.entries(rollupColumnsOf(api, parent, metadata)))
        addCompetingSources(memo.competingTargets, parent, rollupDetail(api.store, state, parent, column, formula));
    }
  }
  return memo.competingTargets.get(table);
}

// A designer Count of a polymorphic target table, indexed under each of its other targets.
function addCompetingSources(competingTargets, parent, entry) {
  if (!entry?.counted) return;
  for (const target of entry.detail.targets ?? []) {
    const competitor = bare(target.entity);
    if (competitor !== parent) addRollupSource(competingTargets, competitor, entry.detail);
  }
}

// Metadata-only index for direct child writes.
function rollupCatalogue(api, state) {
  // Resolve a current metadata snapshot once for this synchronous catalogue
  // scan. A write transaction deliberately cannot reuse a request read epoch:
  // rescanning every form for each unrelated table made this observer quadratic.
  // No permissions, observers or write operations execute inside this scan.
  const metadata = api.metadataSnapshot?.();
  const memo = memoOf(api, metadata);
  if (!memo.sources) {
    memo.sources = new Map();
    for (const table of Object.keys(api.store.state.mappings))
      for (const [column, formula] of Object.entries(rollupColumnsOf(api, table, metadata)))
        indexRollupSource(api.store, state, memo, table, column, formula);
  }
  return memo;
}

function rollupsSourcedFrom(api, state, child) {
  return rollupCatalogue(api, state).sources.get(child) ?? [];
}

function isLocalRegular(api, table) {
  const mapping = api.store.state.mappings?.[table];
  return Boolean(mapping?.idColumn && !tableKind(api.store, table) && !api.virtualProviders?.status(table)?.virtual);
}

// A designer Count whose bare membership this module tracks: a regular local parent and child, and targets that are
// regular local or elastic tables. A virtual target makes every bare child unattributable (rollupParentId), so its
// membership never changes a count.
function tracksMembership(api, source) {
  const store = api.store;
  return (
    isLocalRegular(api, source.table) &&
    isLocalRegular(api, source.child) &&
    source.targets.every(
      ({ entity }) => isLocalRegular(api, bare(entity)) || isElastic(store.state.mappings?.[bare(entity)]),
    )
  );
}

const hasElasticTarget = (store, source) =>
  source.targets.some(({ entity }) => isElastic(store.state.mappings?.[bare(entity)]));

function parentNeedsRollup(store, source, id) {
  const rows = store.state.tables[source.table];
  if (!rows?.length) return false;
  const parent = rows[store.rowIndex(store.resolveMapping(source.table), rows, id)];
  return Boolean(parent && parent[source.column + '_state'] !== STATE.notCalculated);
}

function uniqueParent(store, source, id) {
  return bareRollupTarget(store, source.targets, { [source.link]: id }) === source.table;
}

/**
 * Whether the parent is the one target holding the bare GUID `id` for a child lookup in partition `pid`. `presence`
 * answers for the tables whose membership is changing (true, false), or undefined to read the table as it is now.
 */
function uniqueHolder(store, source, id, pid, presence) {
  const holders = source.targets.filter(
    (target) =>
      presence(bare(target.entity), pid) ?? store.bindingTargetHolds(target, { [`${bare(target.from)}pid`]: pid }, id),
  );
  return holders.length === 1 && bare(holders[0].entity) === source.table;
}

// A bare child row of `id` whose membership can change the value: a designer Average counts every linked row, the other
// aggregates only a non-null value, and a filtered rollup only a row its filter admits.
function isBareCountedRow(row, source, id) {
  const lookup = row?.[source.link];
  if (!sameId(lookup, id) || bare(lookup?.logical_name ?? lookup?.logicalName)) return false;
  if (source.filter && !filterMatches(source.filter, row)) return false;
  return source.aggregate === 'avg' || !isBlank(row?.[source.attribute]);
}

function hasBareCountedRow(store, source, id, skip) {
  const rows = store.state.tables[source.child] ?? [];
  let visited = 0;
  let found = false;
  for (let index = 0; index < rows.length && !found; index++) {
    if (index === skip) continue;
    visited++;
    found = isBareCountedRow(rows[index], source, id);
  }
  countWork(store, 'rowsVisited', visited);
  return found;
}

// Whether a bare counted child row of `id` sees its parent decision change; `changed(pid)` decides per lookup partition.
function hasChangedBareChild(store, source, id, skip, changed) {
  const rows = store.state.tables[source.child] ?? [];
  const decisions = new Map();
  let visited = 0;
  let found = false;
  for (let index = 0; index < rows.length && !found; index++) {
    if (index === skip) continue;
    visited++;
    if (!isBareCountedRow(rows[index], source, id)) continue;
    const pid = rows[index][`${source.link}pid`] ?? null;
    if (!decisions.has(pid)) decisions.set(pid, changed(pid));
    found = decisions.get(pid);
  }
  countWork(store, 'rowsVisited', visited);
  return found;
}

function invalidateMembershipChanges(api, candidates, id, rows, insertedAt) {
  const store = api.store;
  const seen = new Map();
  for (const { source, wasUnique } of candidates) {
    if (wasUnique === uniqueParent(store, source, id)) continue;
    const key = JSON.stringify([source.child, source.link, source.attribute]);
    if (!seen.has(key)) {
      // If the competing table is also the child table, its newly inserted row
      // did not contribute to the previously unique parent. On delete, only
      // surviving rows can contribute to the now-unique parent.
      const skip = rows === store.state.tables[source.child] ? insertedAt : undefined;
      seen.set(key, hasBareCountedRow(store, source, id, skip));
    }
    if (seen.get(key)) markRollupStale(api, source, id);
  }
}

/**
 * A membership change that an elastic table takes part in. Elastic rows are addressed by primary key and partition, so
 * the decision is made per child lookup partition; the changed row's presence is taken from the change itself, because
 * an expired row is already hidden from reads when the TTL purge removes it.
 */
function invalidatePartitionedChanges(api, sources, id, change) {
  const store = api.store;
  for (const source of sources) {
    const presence = (present) => (entity, pid) => {
      if (entity !== change.table) return undefined;
      if (change.partition !== undefined && !samePartition(pid, change.partition)) return undefined;
      return present;
    };
    const changed = (pid) =>
      uniqueHolder(store, source, id, pid, presence(!change.present)) !==
      uniqueHolder(store, source, id, pid, presence(change.present));
    const skip = change.rows === store.state.tables[source.child] ? change.insertedAt : undefined;
    if (hasChangedBareChild(store, source, id, skip, changed)) markRollupStale(api, source, id);
  }
}

function beforeMembershipChange(api, state, table, rows, row, insertedAt) {
  const store = api.store;
  if (rows !== store.state.tables[table]) return undefined;
  const id = bare(row?.[store.state.mappings?.[table]?.idColumn]);
  if (guidKey(id) !== id || !polymorphicTargets(api, state).has(table)) return undefined;
  const sources = competingSourcesOf(api, state, table);
  if (!sources?.length) return undefined;
  const elasticChange = isElastic(store.state.mappings?.[table]);
  const candidates = [];
  const partitioned = [];
  for (const source of sources) {
    if (!parentNeedsRollup(store, source, id) || !tracksMembership(api, source)) continue;
    if (elasticChange || hasElasticTarget(store, source)) partitioned.push(source);
    else candidates.push({ source, wasUnique: uniqueParent(store, source, id) });
  }
  if (!candidates.length && !partitioned.length) return undefined;
  const change = {
    table,
    rows,
    insertedAt,
    present: insertedAt !== undefined,
    partition: elasticChange ? (row.partitionid ?? null) : undefined,
  };
  return () => {
    if (candidates.length) invalidateMembershipChanges(api, candidates, id, rows, insertedAt);
    if (partitioned.length) invalidatePartitionedChanges(api, partitioned, id, change);
  };
}

// ---- Raw target replacement
//
// A writer can replace a whole target table (state.tables[name] = rows: presets, source-component reconciliation,
// persistence and tests) without the row choke points. Before each outermost commit (store.beforeTransactionCommit) the
// row arrays of the polymorphic targets are compared by identity with those seen at the last commit; only a replaced
// array is read, and only a GUID it gained or lost that another regular target of the same lookup also holds can name a
// parent, so a replacement without such a collision resolves no rollup metadata. An isolated changeset works on a copy of
// every array and is compared by content. A whole-state replacement or a rollback starts a new baseline.

// The row array a table holds now, read without handing it out: comparing identities at commit must not make a tracked
// transaction copy a table it never touched into its rollback backup.
const currentRows = (store, table) => untrackedMember(store.state.tables, table) ?? null;

function targetBaseline(api, state) {
  const store = api.store;
  const rows = new Map();
  for (const table of polymorphicTargets(api, state)) rows.set(table, currentRows(store, table));
  state.targetRows = { state: store.state, rows };
}

// The bare GUIDs of a table's rows, each with the partitions that hold it (null for a regular table).
function membershipKeys(store, table, rows) {
  const mapping = store.state.mappings?.[table];
  const elastic = isElastic(mapping);
  const live = store.expiryFilter ? store.expiryFilter(table, rows) : rows;
  countWork(store, 'rowsVisited', live.length);
  const keys = new Map();
  for (const row of live) {
    const id = bare(row?.[mapping?.idColumn]);
    if (guidKey(id) !== id) continue;
    if (!keys.has(id)) keys.set(id, new Set());
    keys.get(id).add(elastic ? (row.partitionid ?? null) : null);
  }
  return keys;
}

function changedKeys(before, after) {
  const changed = [];
  for (const [id, partitions] of before)
    if (!after.has(id) || [...partitions].some((pid) => !after.get(id).has(pid))) changed.push(id);
  for (const [id, partitions] of after)
    if (!before.has(id) || [...partitions].some((pid) => !before.get(id).has(pid))) changed.push(id);
  return [...new Set(changed)];
}

function heldBy(keys, id, pid, elastic) {
  const partitions = keys.get(id);
  return Boolean(partitions && (elastic ? partitions.has(pid ?? null) : partitions.size));
}

// Whether another regular target of a lookup that `table` takes part in holds `id` (the only place a parent can be).
function collides(api, state, replaced, table, id) {
  const store = api.store;
  for (const partner of state.polymorphic.partners.get(table) ?? []) {
    if (!isLocalRegular(api, partner)) continue;
    const entry = replaced.get(partner);
    if (entry) {
      if (entry.before.has(id) || entry.after.has(id)) return true;
    } else if (store.rowIndex(store.resolveMapping(partner), store.tableRows(partner), id) >= 0) return true;
  }
  return false;
}

function invalidateReplacedTargets(api, state, replaced) {
  const store = api.store;
  const done = new Set();
  const elasticOf = (entity) => isElastic(store.state.mappings?.[entity]);
  const presence = (phase, id) => (entity, pid) => {
    const entry = replaced.get(entity);
    return entry ? heldBy(entry[phase], id, pid, elasticOf(entity)) : undefined;
  };
  const invalidate = (source, id) => {
    const key = `${source.table}\u0000${source.column}\u0000${id}`;
    if (done.has(key) || !parentNeedsRollup(store, source, id) || !tracksMembership(api, source)) return;
    done.add(key);
    const differs = (pid) =>
      uniqueHolder(store, source, id, pid, presence('before', id)) !==
      uniqueHolder(store, source, id, pid, presence('after', id));
    if (hasChangedBareChild(store, source, id, undefined, differs)) markRollupStale(api, source, id);
  };
  for (const [table, entry] of replaced)
    for (const changed of changedKeys(entry.before, entry.after))
      if (collides(api, state, replaced, table, changed))
        for (const source of competingSourcesOf(api, state, table) ?? []) invalidate(source, changed);
}

function checkReplacedTargets(api, state, { isolated = false } = {}) {
  const store = api.store;
  const baseline = state.targetRows;
  if (!baseline || (!isolated && baseline.state !== store.state)) return targetBaseline(api, state);
  const replaced = new Map();
  for (const table of polymorphicTargets(api, state)) {
    const rows = currentRows(store, table);
    const previous = baseline.rows.get(table);
    if (previous === undefined || previous === rows) continue;
    const before = membershipKeys(store, table, previous ?? []);
    const after = membershipKeys(store, table, rows ?? []);
    if (changedKeys(before, after).length) replaced.set(table, { before, after });
  }
  targetBaseline(api, state);
  if (replaced.size) invalidateReplacedTargets(api, state, replaced);
}

// Every rollup column whose state is NotCalculated (0), as [table, id, column], read lazily (each state when it is reached).
function* staleColumns(api) {
  const visited = new Set();
  yield* markedColumns(api, visited);
  for (const logical of Object.keys(api.store.state.mappings)) yield* notCalculatedColumns(api, logical, visited);
}

// The marked columns whose row and rollup column still exist; a mark whose row or column is gone is dropped.
function* markedColumns(api, visited) {
  const state = stateOf(api);
  // A copy: a recalculation deletes its mark, and a mark made meanwhile waits for the next run.
  for (const key of [...state.stale] /* NOSONAR: iterate a snapshot of the marks */) {
    visited.add(key);
    const [logical, id, column] = key.split(' ');
    if (markedRowExists(api, logical, id, column)) yield [logical, id, column];
    else state.stale.delete(key);
  }
}

// The NotCalculated (0) rollup columns of one table that no mark already named.
function* notCalculatedColumns(api, logical, visited) {
  const columns = Object.keys(rollupColumnsOf(api, logical));
  if (!columns.length) return;
  const mapping = api.store.resolveMapping(logical);
  /* NOSONAR */ for (const row of [...api.store.tableRows(logical)])
    for (const column of columns)
      if (
        row[`${column}_state`] === STATE.notCalculated &&
        !visited.has(staleKey(logical, row[mapping.idColumn], column))
      )
        yield [logical, row[mapping.idColumn], column];
}

function markedRowExists(api, logical, id, column) {
  const mapping = api.store.state.mappings?.[logical];
  if (!mapping || !Object.hasOwn(rollupColumnsOf(api, logical), column)) return false;
  const rows = api.store.state.tables[logical] ?? [];
  return api.store.rowIndex(api.store.resolveMapping(logical), rows, id) >= 0;
}

/**
 * The mass recalculation: every marked and every NotCalculated (0) rollup column, row by row. One column that fails is
 * reported (ROLLUP_RECALCULATION_FAILED, once per table and column) and keeps its mark for the next run; the others still
 * run. Returns the count recalculated.
 */
async function recalculateStale(api) {
  const state = stateOf(api);
  let count = 0;
  for (const [logical, id, column] of staleColumns(api)) {
    try {
      await recalculate(api, logical, id, column);
      count += 1;
    } catch (error) {
      if (error?.status === 404) clearStale(state, logical, id, column);
      report(state, {
        code: 'ROLLUP_RECALCULATION_FAILED',
        table: logical,
        column,
        id,
        message: `Recalculating ${logical}.${column} of ${id} failed: ${error?.message ?? error}`,
      });
    }
  }
  return count;
}

// The recurring task re-arms itself after each run; a failed run is reported and the next one still comes.
function scheduleMass(api, state) {
  if (!api.scheduler?.schedule) return;
  // Tracing: a run with stale columns is a job root (dataverse-async.mjs runJob, kind rollup-mass) whose rows event counts
  // the recalculated columns; a run with nothing stale records nothing.
  const run = async () => {
    state.massHandle = null;
    try {
      if (!staleColumns(api).next().done)
        await runJob(api.store, { name: MASS_JOB, kind: 'rollup-mass' }, async (span) => {
          const rows = await recalculateStale(api);
          span?.event('rows', { attributes: { operation: 'recalculate', rows } });
        });
    } catch (error) {
      state.reporter.report(
        { code: 'ROLLUP_MASS_RECALCULATION_FAILED', message: error.message },
        `ROLLUP_MASS_RECALCULATION_FAILED\u0000${error.message}`,
      );
    }
    if (!state.closed) state.massHandle = api.scheduler.schedule(run, MASS_INTERVAL_MS, { name: MASS_JOB });
  };
  state.massHandle = api.scheduler.schedule(run, MASS_INTERVAL_MS, { name: MASS_JOB });
  state.massScheduled = state.massHandle !== null;
}

// The parent references a child row holds through the given rollup links, with the ancestors of a hierarchical rollup:
// [{ table, column, id }]. A row of a hierarchical parent table names the ancestors its hierarchy lookup reaches.
const parentsOf = (store, sources, row) =>
  sources.flatMap((source) => {
    if (!row) return [];
    const id = source.hierarchyOnly ? bare(row[source.hierarchyLink]) : rollupParentId(store, source, row);
    if (id === '') return [];
    const ids = source.hierarchyLink ? [id, ...ancestorsOf(store, source, id)] : [id];
    return ids.map((parent) => ({ table: source.table, column: source.column, id: parent }));
  });

// The rows above `id` through the hierarchical lookup of the parent table, nearest first (a cycle ends the walk).
function ancestorsOf(store, source, id) {
  const mapping = store.resolveMapping(source.table);
  const rows = store.tableRows(mapping.logicalName);
  const found = [];
  const seen = new Set([id]);
  let current = id;
  for (;;) {
    const row = rows[store.rowIndex(mapping, rows, current)];
    const next = bare(row?.[source.hierarchyLink]);
    if (!next || seen.has(next)) return found;
    seen.add(next);
    found.push(next);
    current = next;
  }
}

// A stale mark for the parent and, for a hierarchical rollup, every ancestor whose value includes it.
function markRollupStale(api, source, id) {
  const ids = source.hierarchyLink ? [id, ...ancestorsOf(api.store, source, id)] : [id];
  for (const parent of ids) markStale(api, { table: source.table, column: source.column, id: parent });
}

// The platform writes rollup values as an administrator, as the cascade module does; the caller only authorizes its own write.
const PLATFORM = { admin: true };

// ---- Stale marks
//
// Hosted runs (summary-F6 DATA-04c) show that a child write changes neither the parent's value nor its _state or _date: the
// platform's own job recalculates later. Mirage keeps the parents its mass recalculation must visit outside the rows: a mark
// made inside a transaction is pending on that transaction and joins the committed marks when it commits, and a rollback
// drops it. Marks live with the running module; after a restart the mass recalculation visits only NotCalculated rows.

const staleKey = (table, id, column) => [table, bare(id), column].join('\u0000');

function outermostBoundary(store) {
  let boundary = store.inTransaction() ? store.pluginRollbackBoundary : null;
  while (boundary?.parent) boundary = boundary.parent;
  return boundary ?? null;
}

function pendingMarks(api, state) {
  const store = api.store;
  const boundary = outermostBoundary(store);
  if (!boundary) return null;
  let marks = state.pendingMarks.get(boundary);
  if (!marks) {
    marks = new Set();
    state.pendingMarks.set(boundary, marks);
    store.onCommit(() => {
      for (const key of marks) state.stale.add(key);
      state.pendingMarks.delete(boundary);
    });
    store.onRollback(() => state.pendingMarks.delete(boundary));
  }
  return marks;
}

function markStale(api, parent) {
  const state = stateOf(api);
  const mapping = api.store.resolveMapping(parent.table);
  const rows = api.store.state.tables[mapping.logicalName];
  if (!rows || api.store.rowIndex(mapping, rows, parent.id) < 0) return;
  const key = staleKey(mapping.logicalName, parent.id, parent.column);
  if (state.stale.has(key)) return;
  (pendingMarks(api, state) ?? state.stale).add(key);
}

function isStale(api, table, id, column) {
  const state = stateOf(api);
  const key = staleKey(api.store.resolveMapping(table).logicalName, id, String(column).toLowerCase());
  if (state.stale.has(key)) return true;
  const boundary = outermostBoundary(api.store);
  return Boolean(boundary && state.pendingMarks.get(boundary)?.has(key));
}

const clearStale = (state, table, id, column) => state.stale.delete(staleKey(table, id, column));

// A deleted row keeps no mark: dropped when its delete commits (a rollback keeps the row and its marks).
function dropRowMarks(api, state, table, id) {
  const columns = Object.keys(rollupColumnsOf(api, table));
  if (!columns.length) return;
  const drop = () => {
    for (const column of columns) clearStale(state, table, id, column);
  };
  if (outermostBoundary(api.store)) api.store.onCommit(drop);
  else drop();
}

/**
 * recalculate(api, table, id, column): computes one rollup column of one row and stores the value with its date and state.
 * Returns { table, id, column, value, state, date }. Rejects with 400 when the column is not a rollup and 404 for an unknown row.
 */
export async function recalculate(api, table, id, column) {
  const state = stateOf(api);
  const mapping = api.store.resolveMapping(table);
  const logical = mapping.logicalName;
  const name = String(column).toLowerCase();
  const formula = rollupColumnsOf(api, logical)[name];
  if (formula === undefined) throw invalid(`The ${name} column has no rollup definition.`);
  const row = api.store.tableRows(logical).find((item) => sameId(item[mapping.idColumn], id));
  if (!row) throw notFound(logical, id);
  // The write runs on the asynchronous pipeline (updateRecordAsync): a synchronous service endpoint step on the row posts in
  // process, never on the synchronous I/O bridge.
  return api.change(() =>
    api.store.transact(
      async () => {
        const now = new Date(api.clock ? api.clock() : Date.now()).toISOString();
        const { value, stateValue } = calculateRollup(api, state, logical, name, formula, row, mapping);
        await api.store.updateRecordAsync(
          logical,
          row[mapping.idColumn],
          { [name]: value, [`${name}_state`]: stateValue, [`${name}_date`]: now },
          PLATFORM,
          {
            systemColumns: { modifiedon: row.modifiedon },
          },
        );
        api.store.onCommit(() => clearStale(state, logical, row[mapping.idColumn], name));
        return { table: logical, id: row[mapping.idColumn], column: name, value, state: stateValue, date: now };
      },
      { incremental: true },
    ),
  );
}

function calculateRollup(api, state, logical, name, formula, row, mapping) {
  const override = state.overrides[`${logical}.${name}`];
  if (override) return calculatePackRollup(api, state, logical, name, row, override);
  return calculateFormulaRollup(api, state, logical, name, formula, row, mapping);
}

function calculatePackRollup(api, state, logical, name, row, override) {
  // A pack function is arbitrary code: the write's row journal becomes a full backup first, as a plug-in step does.
  api.store.promoteRowTransaction();
  const answer = override(cloneStateData(row), { table: logical, column: name });
  if (isThenable(answer)) {
    report(state, {
      code: 'ROLLUP_UNSUPPORTED',
      table: logical,
      column: name,
      message: 'The pack rollups function returned a promise; rollups are computed synchronously.',
    });
    return { value: null, stateValue: STATE.overflowError };
  }
  return { value: answer ?? null, stateValue: STATE.calculated };
}

function calculateFormulaRollup(api, state, logical, name, formula, row, mapping) {
  const rule = parsedOf(state, formula);
  try {
    if (rule.unsupported) unsupported(rule.unsupported);
    const refused = refusedTableReason(api.store, logical, rule.child);
    if (refused) unsupported(refused);
    const source = rollupSource(api.store, logical, rule);
    if (!source)
      unsupported('The designer rollup relationship does not match a direct child lookup in the table metadata.');
    if (hasVirtualTarget(api.store, source))
      report(state, {
        code: 'ROLLUP_BARE_LOOKUP_UNRESOLVED',
        table: logical,
        column: name,
        message: `${rule.child}.${source.link} also targets a virtual table, whose rows are not stored locally: a child that holds a bare GUID without its table is not counted.`,
      });
    return {
      value: aggregateOf(
        api.store,
        rule,
        source,
        api.store.tableRows(rule.child),
        row[mapping.idColumn],
        rollupPlaces(api, logical, name),
      ),
      stateValue: STATE.calculated,
    };
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    report(state, {
      code: 'ROLLUP_UNSUPPORTED',
      table: logical,
      column: name,
      message: `${error.message} The column reads as null with state 2; supply a pack rollups['${logical}.${name}'] function.`,
    });
    return { value: null, stateValue: STATE.overflowError };
  }
}

/**
 * install(api, { rollups, diagnostic }): rollups is the pack export (validateRollups), diagnostic receives each diagnostic once.
 * Exposes api.rollups = { diagnostics(), recalculate(table, id, column), recalculateStale() }; the CalculateRollupField message
 * (dataverse-record-messages.mjs) calls recalculate through it.
 */
function install(api, options = {}) {
  const state = stateOf(api);
  state.overrides = validateRollups(options.rollups ?? packOverrides(api, 'rollups'));
  state.reporter = onceReporter(options.diagnostic ?? api.diagnostic ?? null);
  api.rollups = {
    diagnostics: () => [...state.reporter.diagnostics],
    recalculate: (table, id, column) => recalculate(api, table, id, column),
    recalculateStale: () => recalculateStale(api),
    isStale: (table, id, column) => isStale(api, table, id, column),
  };
  state.closed = false;
  state.membershipChange = (...args) => beforeMembershipChange(api, state, ...args);
  api.store.beforeRowMembershipChange = state.membershipChange;
  state.commitCheck = (options) => checkReplacedTargets(api, state, options);
  state.rollbackCheck = () => targetBaseline(api, state);
  api.store.beforeTransactionCommit = state.commitCheck;
  api.store.afterTransactionRollback = state.rollbackCheck;
  targetBaseline(api, state);
  scheduleMass(api, state);
  /* NOSONAR */ api.recordHooks.add('beforeWrite', (c, mapping, { operation, data, existing }) => {
    const table = mapping.logicalName;
    const rollups = rollupColumnsOf(api, table);
    if (operation !== 'delete' && data) {
      // A write to a rollup column is accepted and ignored, as hosted writes answer 204 and keep the stored value.
      for (const key of Object.keys(data)) if (Object.hasOwn(rollups, key.toLowerCase())) delete data[key];
      if (operation === 'create' || (operation === 'upsert' && !existing)) {
        // A new parent is Calculated at its creation time with the value of no children (0, or null for MIN and MAX).
        const now = new Date(api.clock ? api.clock() : Date.now()).toISOString();
        const stamped = [];
        for (const [column, formula] of Object.entries(rollups)) {
          data[column] = emptyValue(parsedOf(state, formula));
          if (!hasKey(data, `${column}_state`)) data[`${column}_state`] = STATE.calculated;
          if (hasKey(data, `${column}_date`)) continue;
          data[`${column}_date`] = now;
          stamped.push(`${column}_date`);
        }
        // afterWrite moves each stamped _date to the created row's own createdon.
        if (stamped.length) createdStamps.set(c, [...(createdStamps.get(c) ?? []), { table, stamped }]);
      }
    }
    const sources = rollupsSourcedFrom(api, state, table);
    const before = existing ? parentsOf(api.store, sources, existing) : [];
    if (!before.length) return;
    const list = pending.get(c) ?? [];
    list.push({ table, operation, parents: before });
    pending.set(c, list);
  });
  api.recordHooks.add('afterWrite', (c, mapping, { operation, id }) => {
    const table = mapping.logicalName;
    if (operation === 'create' || operation === 'upsert') stampCreatedOn(api, c, mapping, id);
    if (operation === 'delete') dropRowMarks(api, state, table, id);
    const sources = rollupsSourcedFrom(api, state, table);
    if (!sources.length) return;
    const list = pending.get(c) ?? [];
    const index = list.findLastIndex((entry) => entry.table === table && entry.operation === operation);
    const [entry] = index < 0 ? [] : list.splice(index, 1);
    const current =
      operation === 'delete'
        ? null
        : (api.store.tableRows(table).find((row) => sameId(row[mapping.idColumn], id)) ?? null);
    const seen = new Set();
    for (const parent of [...(entry?.parents ?? []), ...parentsOf(api.store, sources, current)]) {
      const key = `${parent.table}\u0000${parent.column}\u0000${parent.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      markStale(api, parent);
    }
  });
}

/** Validates a pack's rollups export: '<table>.<column>' keys mapping to synchronous (row, ctx) => value functions. Returns the map. */
export function validateRollups(map) {
  return validateDerivedColumns(map, 'rollups');
}

// Reseed: parsed formulas and the once-per-column diagnostics start again (the metadata may have changed).
function reset(api) {
  const state = stateOf(api);
  state.parsed.clear();
  state.memo = null;
  state.polymorphic = null;
  state.reporter.clear();
  // A reseed replaces the rows the marks named.
  state.stale.clear();
  state.pendingMarks = new WeakMap();
}

function close(api) {
  const state = stateOf(api);
  state.closed = true;
  if (api.store.beforeRowMembershipChange === state.membershipChange) delete api.store.beforeRowMembershipChange;
  if (api.store.beforeTransactionCommit === state.commitCheck) delete api.store.beforeTransactionCommit;
  if (api.store.afterTransactionRollback === state.rollbackCheck) delete api.store.afterTransactionRollback;
  if (state.massHandle != null) api.scheduler?.cancel?.(state.massHandle);
  state.massHandle = null;
}

/** Capability record for the capability registry. The periodic job is behaviour when this api scheduled it, else contract. */
function describe(api) {
  const scheduled = Boolean(api && states.get(api)?.massScheduled);
  return {
    name: 'dataverse-rollup',
    version: 1,
    kind: 'dataverse-extension',
    level: 'behaviour',
    operations: scheduled ? [...BEHAVIOUR_OPERATIONS, ...CONTRACT_OPERATIONS] : BEHAVIOUR_OPERATIONS,
    ...(scheduled ? {} : { contractOperations: CONTRACT_OPERATIONS }),
    requires: ['metadata:FormulaDefinition', 'scheduler'],
    principal: 'platform',
    stateOwner: 'none',
    lifecycle: 'per-request',
  };
}

export const EXTENSION = { name: 'dataverse-rollup', install, reset, close, describe };

registerPackExport('rollups', { key: (key) => key.toLowerCase(), check: packCheck(validateRollups) });
