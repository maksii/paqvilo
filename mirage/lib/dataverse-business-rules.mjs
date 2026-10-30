// Business rules (workflow category 2) in the Dataverse API: the server-side subset, evaluated inside the write.
//
// A business rule is a workflow row with category 2, type 1 (definition), statecode 1 (activated) and primaryentity = the
// table. Only rules with processtriggerscope 2 (Entity: "Model-driven app forms and server") run on the server; Form and
// All Forms scopes are client only and are left to the model-driven host (businessRulesFor). On create, update and upsert
// the beforeWrite hook evaluates each server rule against the merged row (existing values with the payload over them):
//   1. a trusted pack's businessRules['<workflowid>'](ctx) wins and returns { target?, error? };
//   2. else the rule's XAML is parsed into the supported subset and its actions applied to the payload;
//   3. else (XAML outside the subset) the rule reports BUSINESS_RULE_UNSUPPORTED once and does nothing.
// Rules run synchronously, in workflow-table order, inside the write's transaction, before the row is stored: an error
// rolls the whole write back. Like a JavaScript plug-in handler, a rule cannot write other rows (it only patches the
// payload), so it adds no depth; its context carries UserId and InitiatingUserId as plug-in handlers do.
//
// Supported XAML subset (element local names, case-insensitive, prefixes ignored; the root element's children are the steps):
//   <SetAttributeValueStep Attribute="x" Value="v"/>      set value
//   <SetDefaultValueStep Attribute="x" Value="v"/>        set default value (create only, when the merged value is empty)
//   <SetMessageStep Message="text" Attribute="x"?/>       show error message: the write fails with 400
//   <SetFieldRequiredLevelStep Attribute="x" RequiredLevel="required|none"/>  required: the write fails when x is empty
//   <ConditionBranchStep Logic="and|or"> <Condition Attribute="x" Operator="eq|ne|gt|ge|lt|le|null|not-null" Value="v"/>…
//     <Then>steps</Then> <Else>steps</Else>? </ConditionBranchStep>
//   Client-only steps (no server behaviour; BUSINESS_RULE_CLIENT_ONLY once per rule): <SetVisibilityStep>,
//   <SetDisplayModeStep> (lock/unlock), <RecommendationStep>. The rule's server steps still run.
// Value text is read as JSON when it parses (numbers, true/false, null), else as text.
// The designer's exported XAML wraps steps in Windows Workflow ActivityReference/argument structures, and the
// rule's clientdata is generated JavaScript. Neither is read: exported designer rules report BUSINESS_RULE_UNSUPPORTED and
// a pack businessRules handler supplies their behaviour.
// Steps nest at most 64 condition branches deep; a deeper rule reports BUSINESS_RULE_UNSUPPORTED.
// describe(api) is contract: the subset above is the simulator's own grammar. It is behaviour only when the installed api's pack
// businessRules cover every entity-scope rule of the store.
// Parsed rules are cached per workflow id (replaced when its XAML changes); the activated rules are indexed by primaryentity once
// per store revision.
// ponytail: a workflow row written by a store-level path (not the records pipeline) inside an open transaction is seen by later
// writes of that transaction only after it commits; workflow writes through the records pipeline drop the index at once.
import { DataError } from './data-error.mjs';
import { traceDecision } from './dataverse-security.mjs';
import { parseSolutionXml } from './solution-xml.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';
import { onceReporter, packOverrides } from './dataverse-addon-common.mjs';

const CATEGORY_BUSINESS_RULE = 2;
const TYPE_DEFINITION = 1;
const STATE_ACTIVATED = 1;
const SCOPE_ENTITY = 2;
const MAX_DEPTH = 64;
const SERVER_STEPS = new Set([
  'setattributevaluestep',
  'setdefaultvaluestep',
  'setmessagestep',
  'setfieldrequiredlevelstep',
  'conditionbranchstep',
]);
const CLIENT_STEPS = new Set(['setvisibilitystep', 'setdisplaymodestep', 'recommendationstep']);
const OPERATORS = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'null', 'not-null']);
const OPERATIONS = ['SetAttributeValue', 'SetDefaultValue', 'ShowErrorMessage', 'SetRequiredLevel', 'Condition'];

const bare = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const localName = (name) => String(name).split(':').pop().toLowerCase();
const elements = (node) => (node?.children ?? []).filter((item) => !item.name.startsWith('#'));
const attr = (node, name) =>
  Object.entries(node.attrs ?? {}).find(([key]) => localName(key) === name.toLowerCase())?.[1];
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value);
const empty = (value) => value === null || value === undefined || value === '';
const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';
const valueOf = (text) => {
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

class Unsupported extends Error {}
const unsupported = (message) => {
  throw new Unsupported(message);
};

// The native fault of a server-side rule's "Show error message" is not known; the plug-in fault code 0x80040265
// (InvalidPluginExecutionException) stands in, with the rule's message as the error message.
const ruleError = (message) => new DataError(String(message), 400, 'BusinessRuleError', { innerCode: '0x80040265' });
// The native answer when a rule made a column required and the merged row leaves it empty is not known.
const requiredError = (table, column) =>
  new DataError(
    `A value for the '${column}' column of '${table}' is required by a business rule.`,
    400,
    'InvalidRequest',
    { innerCode: '0x80040203' },
  );

// ---- Parser

function parseSteps(nodes, client, depth = 0) {
  if (depth >= MAX_DEPTH) unsupported(`The business rule nests deeper than ${MAX_DEPTH} condition branches.`);
  return nodes
    .map((node) => {
      const kind = localName(node.name);
      if (CLIENT_STEPS.has(kind)) {
        client.push(kind);
        return null;
      }
      if (!SERVER_STEPS.has(kind)) unsupported(`Business rule step <${node.name}> is not supported.`);
      const column = attr(node, 'Attribute')?.trim().toLowerCase();
      if (kind === 'conditionbranchstep') {
        const children = elements(node);
        const conditions = children
          .filter((item) => localName(item.name) === 'condition')
          .map((item) => {
            const operator = String(attr(item, 'Operator') ?? 'eq').toLowerCase();
            if (!OPERATORS.has(operator)) unsupported(`Condition operator '${operator}' is not supported.`);
            const attribute = attr(item, 'Attribute')?.trim().toLowerCase();
            if (!attribute) unsupported('A condition names no Attribute.');
            return { attribute, operator, value: valueOf(attr(item, 'Value')) };
          });
        if (!conditions.length) unsupported('A ConditionBranchStep has no Condition.');
        const branch = (name) => elements(children.find((item) => localName(item.name) === name));
        const logic = String(attr(node, 'Logic') ?? 'and').toLowerCase();
        if (logic !== 'and' && logic !== 'or') unsupported(`Condition logic '${logic}' is not supported.`);
        for (const item of children)
          if (!['condition', 'then', 'else'].includes(localName(item.name)))
            unsupported(`<${item.name}> is not part of a ConditionBranchStep.`);
        return {
          kind: 'condition',
          logic,
          conditions,
          then: parseSteps(branch('then'), client, depth + 1),
          else: parseSteps(branch('else'), client, depth + 1),
        };
      }
      if (kind === 'setmessagestep')
        return { kind: 'error', message: attr(node, 'Message') ?? node.text.trim(), column: column ?? null };
      if (!column) unsupported(`<${node.name}> names no Attribute.`);
      if (kind === 'setfieldrequiredlevelstep')
        return {
          kind: 'required',
          column,
          required: String(attr(node, 'RequiredLevel') ?? '').toLowerCase() === 'required',
        };
      return { kind: kind === 'setdefaultvaluestep' ? 'default' : 'set', column, value: valueOf(attr(node, 'Value')) };
    })
    .filter(Boolean);
}

/** Parses a business rule's XAML into { steps, clientOnly[] } or { unsupported: reason, clientOnly: [] }. */
export function parseBusinessRule(xaml) {
  const client = [];
  if (!xaml || !String(xaml).trim()) return { unsupported: 'The business rule has no XAML.', clientOnly: client };
  try {
    const root = parseSolutionXml(xaml);
    return { steps: parseSteps(elements(root), client), clientOnly: [...new Set(client)] };
  } catch (error) {
    return {
      unsupported:
        error instanceof Unsupported ? error.message : `The business rule XAML is not readable: ${error.message}`,
      clientOnly: [],
    };
  }
}

// ---- Evaluator

const comparable = (value) => {
  value = refId(value);
  if (empty(value)) return null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return typeof value === 'string' ? value.toLowerCase() : value;
};
function test(condition, row) {
  const actual = comparable(row[condition.attribute]);
  const expected = comparable(condition.value);
  switch (condition.operator) {
    case 'null':
      return actual === null;
    case 'not-null':
      return actual !== null;
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
  }
  if (actual === null || expected === null) return false;
  if (condition.operator === 'gt') return actual > expected;
  if (condition.operator === 'ge') return actual >= expected;
  if (condition.operator === 'lt') return actual < expected;
  return actual <= expected;
}

// Applies the steps to the payload (data) and the merged row; collects required columns; throws a rule's error.
function apply(steps, { data, merged, creating, required }) {
  for (const step of steps) {
    if (step.kind === 'condition') {
      const results = step.conditions.map((condition) => test(condition, merged));
      const passed = step.logic === 'or' ? results.some(Boolean) : results.every(Boolean);
      apply(passed ? step.then : step.else, { data, merged, creating, required });
    } else if (step.kind === 'error') throw ruleError(step.message);
    else if (step.kind === 'required') {
      if (step.required) required.add(step.column);
      else required.delete(step.column);
    } else if (step.kind === 'set' || (creating && empty(merged[step.column]))) {
      data[step.column] = step.value;
      merged[step.column] = step.value;
    }
  }
}

// ---- Rules of a table

const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api))
    states.set(api, { overrides: {}, reporter: onceReporter(), parsed: new Map(), index: null, uncached: null });
  return states.get(api);
}

const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.workflowId}`);

const isRule = (row) =>
  Number(row.category) === CATEGORY_BUSINESS_RULE &&
  Number(row.type ?? TYPE_DEFINITION) === TYPE_DEFINITION &&
  Number(row.statecode) === STATE_ACTIVATED;
const tableOf = (row) => String(row.primaryentity ?? '').toLowerCase();

// One rule row, parsed through the cache: parsed maps a workflow id to { xaml, parsed }, replaced when the XAML changes.
function ruleOf(row, parsed) {
  const workflowId = bare(row.workflowid);
  const xaml = row.xaml ?? '';
  let entry = parsed.get(workflowId);
  if (entry?.xaml !== xaml) parsed.set(workflowId, (entry = { xaml, parsed: parseBusinessRule(xaml) }));
  return {
    workflowId,
    name: row.name ?? null,
    table: tableOf(row),
    scope: Number(row.processtriggerscope) === SCOPE_ENTITY ? 'entity' : 'form',
    formId: row.processtriggerformid ? bare(refId(row.processtriggerformid)) : null,
    ...entry.parsed,
  };
}

// The activated rule rows by primaryentity, rebuilt once per store revision (never cached while state.uncached names it).
function ruleRows(api, state) {
  const revision = api.store.revision;
  if (typeof revision === 'number' && state.index?.revision === revision) return state.index.byTable;
  const byTable = new Map();
  for (const row of api.store.tableRows('workflow')) {
    if (!isRule(row)) continue;
    const table = tableOf(row);
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(row);
  }
  if (typeof revision === 'number' && revision !== state.uncached) state.index = { revision, byTable };
  return byTable;
}

/**
 * The activated business rules of a table, parsed: [{ workflowId, name, table, scope ("entity" | "form"), formId, steps?,
 * clientOnly[], unsupported? }]. Every scope is listed, so the model-driven host can consume the same parsed rules for its
 * client-side evaluation; the server evaluates only scope "entity".
 */
export function businessRulesFor(store, table, parsed = new Map()) {
  const logical = String(table ?? '').toLowerCase();
  return store
    .tableRows('workflow')
    .filter((row) => isRule(row) && tableOf(row) === logical)
    .map((row) => ruleOf(row, parsed));
}

// ---- Pack export

/** Validates a pack's businessRules export: workflow GUID keys mapping to synchronous (ctx) => ({ target?, error? }). */
export function validateBusinessRules(map) {
  if (map === undefined) return {};
  if (!map || typeof map !== 'object' || Array.isArray(map))
    throw new TypeError('businessRules must map workflow ids to functions.');
  const result = {};
  for (const [key, fn] of Object.entries(map)) {
    const id = bare(key);
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
      throw new TypeError(`businessRules key '${key}' must be a workflow id (GUID).`);
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction')
      throw new TypeError(`businessRules['${key}'] must be a synchronous function (ctx) => ({ target, error }).`);
    result[id] = fn;
  }
  return result;
}

// ---- Extension

// Runs one rule; answers how it ran: 'override' (a pack handler), 'unsupported' (not evaluated) or 'evaluated'.
function runRule(state, c, mapping, rule, { operation, data, merged, creating, required }) {
  const override = state.overrides[rule.workflowId];
  if (override) {
    const result = override({
      workflowId: rule.workflowId,
      name: rule.name,
      table: mapping.logicalName,
      operation,
      rule: structuredClone(rule),
      target: structuredClone(merged),
      payload: structuredClone(data),
      userId: c.user?.systemuserid ?? null,
      initiatingUserId: c.caller?.systemuserid ?? c.user?.systemuserid ?? null,
    });
    if (isThenable(result))
      throw new DataError('A businessRules handler must return synchronously.', 501, 'LocalBusinessRuleUnsupported');
    if (result?.error)
      throw ruleError(
        typeof result.error === 'string' ? result.error : (result.error.message ?? 'Business rule error.'),
      );
    if (result?.target && typeof result.target === 'object') {
      Object.assign(data, result.target);
      Object.assign(merged, result.target);
    }
    return 'override';
  }
  if (rule.clientOnly.length)
    report(state, {
      code: 'BUSINESS_RULE_CLIENT_ONLY',
      workflowId: rule.workflowId,
      name: rule.name,
      table: mapping.logicalName,
      actions: rule.clientOnly,
      message: `Business rule '${rule.name}' has client-only actions (${rule.clientOnly.join(', ')}); they have no server behaviour.`,
    });
  if (rule.unsupported) {
    report(state, {
      code: 'BUSINESS_RULE_UNSUPPORTED',
      workflowId: rule.workflowId,
      name: rule.name,
      table: mapping.logicalName,
      message: `${rule.unsupported} The rule is not evaluated; supply a pack businessRules['${rule.workflowId}'] handler.`,
    });
    return 'unsupported';
  }
  apply(rule.steps, { data, merged, creating, required });
  return 'evaluated';
}

// Tracing: each rule run is one business-rule event on the write's span, naming the rule, how it ran, the columns it set and
// the error it raised (a raised error fails the write); under a bulk span the rows' runs are one event and the span's
// `businessRules` counts (dataverse-security.mjs traceDecision), never one event per row.
function tracedRule(span, state, c, mapping, rule, facts) {
  if (!span) return runRule(state, c, mapping, rule, facts);
  const before = { ...facts.data };
  const event = (attributes) =>
    traceDecision(span, 'business-rule', {
      attributes: {
        workflowId: rule.workflowId,
        name: rule.name ?? null,
        table: mapping.logicalName,
        operation: facts.operation,
        ...attributes,
      },
    });
  let mode;
  try {
    mode = runRule(state, c, mapping, rule, facts);
  } catch (error) {
    event({ mode: 'error', code: error?.code ?? null, error: error?.message ?? String(error) });
    throw error;
  }
  const changed = Object.keys(facts.data).filter(
    (key) => !Object.hasOwn(before, key) || before[key] !== facts.data[key],
  );
  event({ mode, changed });
  return mode;
}

/**
 * install(api, { businessRules, diagnostic }): businessRules is the pack export (validateBusinessRules), diagnostic receives
 * each diagnostic once. Exposes api.businessRulesFor(table) and api.businessRules = { diagnostics(), describe() }.
 */
function install(api, options = {}) {
  const state = stateOf(api);
  state.overrides = validateBusinessRules(options.businessRules ?? packOverrides(api, 'businessRules'));
  state.reporter = onceReporter(options.diagnostic ?? api.diagnostic ?? null);
  const rulesFor = (table) =>
    (ruleRows(api, state).get(String(table ?? '').toLowerCase()) ?? []).map((row) => ruleOf(row, state.parsed));
  api.businessRulesFor = rulesFor;
  api.businessRules = { diagnostics: () => [...state.reporter.diagnostics], describe: () => describe(api) };
  api.recordHooks.add('beforeWrite', (c, mapping, { operation, data, existing }) => {
    // A workflow write drops the index; until the next commit nothing is cached, so a rolled-back rule never lingers.
    if (mapping.logicalName === 'workflow') {
      state.index = null;
      state.uncached = api.store.revision;
      return;
    }
    if (operation === 'delete' || !data) return;
    const rules = rulesFor(mapping.logicalName).filter((rule) => rule.scope === 'entity');
    if (!rules.length) return;
    const creating = operation === 'create' || (operation === 'upsert' && !existing);
    const merged = { ...(existing ?? {}), ...data };
    const required = new Set();
    const span = api.store.traces?.enabled ? api.store.traces.current() : null;
    for (const rule of rules)
      tracedRule(span, state, c, mapping, rule, { operation, data, merged, creating, required });
    for (const column of required) if (empty(refId(merged[column]))) throw requiredError(mapping.logicalName, column);
  });
}

function reset(api) {
  const state = stateOf(api);
  state.parsed.clear();
  state.index = null;
  state.reporter.clear();
}

/** Capability record: contract, or behaviour when the installed api's pack overrides cover every entity-scope rule. */
function describe(api = null) {
  const overrides = api ? (states.get(api)?.overrides ?? {}) : {};
  const rules = api
    ? api.store.tableRows('workflow').filter((row) => isRule(row) && Number(row.processtriggerscope) === SCOPE_ENTITY)
    : [];
  return {
    name: 'dataverse-business-rules',
    version: 1,
    kind: 'dataverse-extension',
    level:
      rules.length > 0 && rules.every((row) => Object.hasOwn(overrides, bare(row.workflowid)))
        ? 'behaviour'
        : 'contract',
    operations: OPERATIONS,
    requires: ['workflow:category=2'],
    principal: 'caller',
    stateOwner: 'none',
    lifecycle: 'per-request',
  };
}

export const EXTENSION = { name: 'dataverse-business-rules', install, reset, describe };

registerPackExport('businessRules', { key: (key) => bare(key), check: packCheck(validateBusinessRules) });
