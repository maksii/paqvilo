// Built-in data operations of the flow interpreter (flow-runtime.mjs) and the pack `flowActions` seam.
// Each FLOW_ACTIONS entry is (action, ctx) => outputs, run synchronously with
//   ctx = { resolve(value), each(values, fn), maxIterations, validate(value, schema, name) }.
// Native definitions: https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers#action-types-list
// (ParseJson, Select, Query, Join, Table) and https://learn.microsoft.com/azure/logic-apps/logic-apps-perform-data-operations.
// A pack `flowActions` export maps an action type to async (request: { type, inputs }, context) => outputs; the inputs are
// resolved, the call is journalled like a connector action, and an outputs.statusCode of 400 or above fails the action.
// Pack actions are a contract seam: the interpreter does not know their native semantics.
import { DataError } from './data-error.mjs';
import { parseExactJson, stringifyExactJson, isExactNumeric } from './exact-numeric.mjs';
import { registerPackExport } from './pack-exports.mjs';

const fail = (message, status = 400, code = 'LocalFlowExpression') => { throw new DataError(message, status, code); };
const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => value == null ? '' : isExactNumeric(value) ? value.value : typeof value === 'string' ? value : stringifyExactJson(value);
const array = (value, ctx, type) => {
  if (!Array.isArray(value)) fail(`${type} requires a 'from' array.`);
  if (value.length > ctx.maxIterations) fail(`${type} 'from' exceeds the local iteration limit.`, 501, 'LocalFlowUnsupported');
  return value;
};
const escapeHtml = value => text(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// unverified: the native CSV quoting rule; RFC 4180 quoting is applied (a value with a comma, quote or line break is quoted).
const escapeCsv = value => { const s = text(value); return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s; };

/** The interpreter's own action types (flow-runtime.mjs runs them); the data operations are in FLOW_ACTIONS. */
export const CONTROL_ACTIONS = Object.freeze(['Compose', 'InitializeVariable', 'SetVariable', 'IncrementVariable', 'DecrementVariable', 'AppendToArrayVariable',
  'AppendToStringVariable', 'If', 'Scope', 'Foreach', 'Until', 'Switch', 'Response', 'Terminate', 'Wait', 'ChangeSet']);
// Provider-backed and workflow-language types a pack action type cannot take.
const RESERVED = new Set([...CONTROL_ACTIONS, 'OpenApiConnection', 'OpenApiConnectionWebhook', 'ApiConnection', 'ApiConnectionWebhook', 'Http', 'HttpWebhook', 'Workflow', 'Function']);

export const FLOW_ACTIONS = Object.freeze({
  // unverified: the native error code and message of a schema mismatch; ValidationFailed is used locally.
  ParseJson(action, ctx) {
    const inputs = action.inputs ?? {}, content = ctx.resolve(inputs.content);
    let body = content;
    if (typeof content === 'string') { try { body = parseExactJson(content); } catch { fail('ParseJson content is not valid JSON.', 400, 'InvalidJSON'); } }
    if (inputs.schema !== undefined) {
      if (!isMap(inputs.schema)) fail('ParseJson schema must be a JSON schema object.');
      try { ctx.validate(body, inputs.schema, 'content'); } catch (error) { fail('The schema validation failed: ' + error.message, 400, 'ValidationFailed'); }
    }
    return { body };
  },
  Select(action, ctx) {
    const inputs = action.inputs ?? {};
    if (inputs.select === undefined) fail("Select requires a 'select' map or expression.");
    return { body: ctx.each(array(ctx.resolve(inputs.from), ctx, 'Select'), () => ctx.resolve(inputs.select)) };
  },
  Query(action, ctx) {
    const inputs = action.inputs ?? {}, from = array(ctx.resolve(inputs.from), ctx, 'Query');
    const keep = ctx.each(from, () => { const test = ctx.resolve(inputs.where); if (typeof test !== 'boolean') fail("Query 'where' must be a boolean expression."); return test; });
    return { body: from.filter((_, i) => keep[i]) };
  },
  Join(action, ctx) {
    const inputs = action.inputs ?? {}, from = array(ctx.resolve(inputs.from), ctx, 'Join'), joinWith = ctx.resolve(inputs.joinWith);
    if (typeof joinWith !== 'string') fail("Join requires a 'joinWith' string.");
    return { body: from.map(text).join(joinWith) };
  },
  // columns: [{ header, value }] (value resolved per item) or the keys of the first item (format CSV or HTML).
  // unverified: the native HTML markup and the header row of automatic columns.
  Table(action, ctx) {
    const inputs = action.inputs ?? {}, from = array(ctx.resolve(inputs.from), ctx, 'Table'), format = String(inputs.format ?? '').toUpperCase();
    if (!['CSV', 'HTML'].includes(format)) fail("Table 'format' must be CSV or HTML.");
    let headers, rows;
    if (inputs.columns !== undefined) {
      if (!Array.isArray(inputs.columns) || inputs.columns.some(c => !isMap(c) || typeof c.header !== 'string')) fail("Table 'columns' must be [{ header, value }].");
      headers = inputs.columns.map(c => c.header);
      rows = ctx.each(from, () => inputs.columns.map(c => ctx.resolve(c.value)));
    } else {
      if (from.some(item => !isMap(item))) fail('Table items must be objects when no columns are given.');
      headers = Object.keys(from[0] ?? {});
      rows = from.map(item => headers.map(key => item[key]));
    }
    if (format === 'CSV') return { body: [headers, ...rows].map(row => row.map(escapeCsv).join(',')).join('\r\n') };
    return { body: '<table><thead><tr>' + headers.map(h => '<th>' + escapeHtml(h) + '</th>').join('') + '</tr></thead><tbody>'
      + rows.map(row => '<tr>' + row.map(v => '<td>' + escapeHtml(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table>' };
  },
});

const reserved = type => RESERVED.has(type) || Object.hasOwn(FLOW_ACTIONS, type);
/** Pack flowActions entries of every pack: { [actionType]: handler }. A built-in type cannot be replaced. */
export function packFlowActions(packs = []) {
  const result = {};
  for (const pack of packs) for (const [type, handler] of Object.entries(pack.flowActions ?? {})) {
    if (reserved(type)) throw new Error(`Data pack ${pack.id}: flowActions.${type} replaces a built-in flow action`);
    if (Object.hasOwn(result, type)) throw new Error(`Data pack ${pack.id}: flowActions.${type} is declared by more than one pack`);
    result[type] = handler;
  }
  return result;
}

registerPackExport('flowActions', {
  check(value, packId) {
    if (!isMap(value)) throw new Error(`Data pack ${packId}: flowActions must map action types to functions`);
    for (const [type, handler] of Object.entries(value))
      if (!/^[A-Za-z][\w]{0,99}$/.test(type) || reserved(type) || typeof handler !== 'function') throw new Error(`Data pack ${packId}: flowActions.${type} must be a function under a new action type`);
  },
});
